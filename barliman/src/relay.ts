import { BaseError, ContractFunctionRevertedError, encodeFunctionData, zeroHash, type Abi, type Address, type Hex } from 'viem'
import { DATA_REGISTRY_ABI } from '@fangorn-network/sdk/lib/contracts/data-registry/abi.js'
import { SETTLEMENT_REGISTRY_ABI } from '@fangorn-network/sdk/lib/contracts/settlement-registry/abi.js'

// The relay: submits transactions publishers and buyers signed, with the treasury paying gas.
//   POST /relay/commit    { publisher, update: { repo, epoch, parent, root, car }, signature }
//   POST /relay/register  register's arguments without referrer (the treasury is the referrer)
//   POST /relay/settle    settle's arguments
// Bigints are decimal strings. Each returns { tx } or an error with the revert reason.

export interface Call {
	address: Address
	abi: Abi
	functionName: string
	args: readonly unknown[]
}

export interface Chain {
	/** Throws if the call would revert. Returns what `send` needs. */
	simulate(call: Call): Promise<unknown>
	send(request: unknown): Promise<Hex>
}

export interface Relay {
	chain: Chain
	kv: KVNamespace
	treasury: Address
	dataRegistry: Address
	settlementRegistry: Address
}

export class RelayError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message)
	}
}

/** Per address per day. Paid registers and settles aren't limited: the buyer pays more than the gas, and a settle needs a real proof. */
export const LIMITS = { commit: 100, freeRegister: 20 }

const day = () => new Date().toISOString().slice(0, 10)

// ponytail: KV read-then-write, so a burst can overshoot a limit slightly. Durable Object if it must be exact.
async function checkLimit(kv: KVNamespace, kind: keyof typeof LIMITS, who: string): Promise<() => Promise<void>> {
	const key = `${kind}:${who.toLowerCase()}:${day()}`
	const used = Number(await kv.get(key)) || 0
	if (used >= LIMITS[kind]) throw new RelayError(429, `daily limit of ${LIMITS[kind]} reached`)
	return () => kv.put(key, String(used + 1), { expirationTtl: 2 * 86400 })
}

const ZERO_PAYMENT = { from: '0x0000000000000000000000000000000000000000', value: 0n, validAfter: 0n, validBefore: 0n, nonce: zeroHash, v: 0, r: zeroHash, s: zeroHash }

/** Turn a request body into a contract call. Throws (→ 400) on a malformed body. */
function callFor(route: string, b: any, r: Relay): Call {
	switch (route) {
		case 'commit': {
			const u = b.update
			return {
				address: r.dataRegistry,
				abi: DATA_REGISTRY_ABI as unknown as Abi,
				functionName: 'updateBySig',
				args: [b.publisher, u.repo, BigInt(u.epoch), u.parent, u.root, u.car, b.signature],
			}
		}
		case 'register': {
			const t = b.terms
			const terms = { ...t, price: BigInt(t.price), generation: BigInt(t.generation), deadline: BigInt(t.deadline) }
			const p = b.payment
			const payment =
				terms.price === 0n
					? ZERO_PAYMENT
					: { ...p, value: BigInt(p.value), validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore) }
			return {
				address: r.settlementRegistry,
				abi: SETTLEMENT_REGISTRY_ABI as unknown as Abi,
				functionName: 'register',
				args: [terms, b.signature, BigInt(b.commitment), r.treasury, b.salt, payment],
			}
		}
		case 'settle':
			return {
				address: r.settlementRegistry,
				abi: SETTLEMENT_REGISTRY_ABI as unknown as Abi,
				functionName: 'settle',
				args: [b.subject, b.reader, BigInt(b.merkleTreeDepth), BigInt(b.merkleTreeRoot), BigInt(b.nullifier), b.points.map(BigInt)],
			}
	}
	throw new RelayError(404, 'not found')
}

/** Who a call is limited by, if anyone. `ip` is used for free registers because nothing in them is signed by a payer. */
function limitFor(route: string, call: Call, ip: string): [keyof typeof LIMITS, string] | null {
	if (route === 'commit') return ['commit', call.args[0] as string]
	if (route === 'register' && (call.args[0] as { price: bigint }).price === 0n) return ['freeRegister', ip]
	return null
}

/** With `send: false`, stops after the simulation (x402's /verify) and returns no tx. */
export async function relay(route: string, body: unknown, ip: string, r: Relay, send = true): Promise<{ tx: Hex | null }> {
	let call: Call
	try {
		call = callFor(route, body, r)
		encodeFunctionData(call as never) // catches wrong types and shapes before any RPC
	} catch (e) {
		if (e instanceof RelayError) throw e
		throw new RelayError(400, 'malformed request')
	}

	const limit = limitFor(route, call, ip)
	const count = limit ? await checkLimit(r.kv, ...limit) : null

	let request: unknown
	try {
		request = await r.chain.simulate(call)
	} catch (e) {
		const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null
		if (revert instanceof ContractFunctionRevertedError) {
			throw new RelayError(422, revert.data?.errorName ?? revert.reason ?? revert.shortMessage)
		}
		console.error(e)
		throw new RelayError(502, 'simulation failed')
	}

	if (!send) return { tx: null }
	const tx = await r.chain.send(request)
	await count?.()
	return { tx }
}
