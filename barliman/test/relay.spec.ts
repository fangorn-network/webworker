import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { ContractFunctionRevertedError, type Abi, type Address, type Hex } from 'viem'
import { LIMITS, relay, type Call, type Relay } from '../src/relay'

const TREASURY = '0x00000000000000000000000000000000000000fe' as Address
const PUBLISHER = '0x1111111111111111111111111111111111111111' as Address
const H = (b: string) => `0x${b.repeat(32)}` as Hex

/** A fake chain that records what it simulated and sent. `reverts` makes every simulation revert. */
function fakeChain(reverts = false) {
	const simulated: Call[] = []
	const sent: Call[] = []
	return {
		simulated,
		sent,
		simulate: async (call: Call) => {
			simulated.push(call)
			if (reverts) throw new ContractFunctionRevertedError({ abi: call.abi as Abi, functionName: call.functionName, message: 'EpochOutOfWindow' })
			return call
		},
		send: async (request: unknown) => {
			sent.push(request as Call)
			return H('ab')
		},
	}
}

const relayWith = (chain: ReturnType<typeof fakeChain>): Relay => ({
	chain,
	kv: env.RATE_KV,
	treasury: TREASURY,
	dataRegistry: '0x00000000000000000000000000000000000000d0',
	settlementRegistry: '0x00000000000000000000000000000000000000e0',
})

const commit = {
	publisher: PUBLISHER,
	update: { repo: 'notes', epoch: 490000, parent: H('00'), root: H('11'), car: '0x0155' },
	signature: '0x1234',
}

const register = (price: string, extra: object = {}) => ({
	terms: { publisher: PUBLISHER, repo: H('22'), key: H('33'), price, shareBps: 500, generation: '0', deadline: '2000000000' },
	signature: '0x1234',
	commitment: '42',
	salt: H('44'),
	payment: { from: PUBLISHER, value: price, validAfter: '0', validBefore: '2000000000', nonce: H('55'), v: 27, r: H('66'), s: H('77') },
	...extra,
})

beforeEach(async () => {
	const { keys } = await env.RATE_KV.list()
	await Promise.all(keys.map((k) => env.RATE_KV.delete(k.name)))
})

describe('relay', () => {
	it('sends a commit and returns the tx', async () => {
		const chain = fakeChain()
		expect(await relay('commit', commit, '1.2.3.4', relayWith(chain))).toEqual({ tx: H('ab') })
		expect(chain.sent[0].functionName).toBe('updateBySig')
	})

	it('never sends a call that would revert, and returns the revert reason', async () => {
		const chain = fakeChain(true)
		await expect(relay('commit', commit, '1.2.3.4', relayWith(chain))).rejects.toMatchObject({ status: 422, message: 'EpochOutOfWindow' })
		expect(chain.sent).toHaveLength(0)
	})

	it('refuses a malformed body before touching the chain', async () => {
		const chain = fakeChain()
		await expect(relay('commit', { publisher: 'nope' }, '1.2.3.4', relayWith(chain))).rejects.toMatchObject({ status: 400 })
		await expect(relay('settle', {}, '1.2.3.4', relayWith(chain))).rejects.toMatchObject({ status: 400 })
		expect(chain.simulated).toHaveLength(0)
	})

	it('ignores a referrer in the body: the treasury is always the referrer', async () => {
		const chain = fakeChain()
		await relay('register', register('10000', { referrer: '0x000000000000000000000000000000000000bad0' }), '1.2.3.4', relayWith(chain))
		expect(chain.sent[0].args[3]).toBe(TREASURY)
	})

	it('holds the daily commit limit per publisher', async () => {
		const chain = fakeChain()
		for (let i = 0; i < LIMITS.commit; i++) await relay('commit', commit, '1.2.3.4', relayWith(chain))
		await expect(relay('commit', commit, '1.2.3.4', relayWith(chain))).rejects.toMatchObject({ status: 429 })
		expect(chain.sent).toHaveLength(LIMITS.commit)
	}, 60_000)

	it('a reverted call does not use up the limit', async () => {
		await expect(relay('commit', commit, '1.2.3.4', relayWith(fakeChain(true)))).rejects.toMatchObject({ status: 422 })
		expect(await env.RATE_KV.list().then((l) => l.keys.length)).toBe(0)
	})

	it('limits free registers per IP, and not paid ones', async () => {
		const chain = fakeChain()
		for (let i = 0; i < LIMITS.freeRegister; i++) await relay('register', register('0'), '1.2.3.4', relayWith(chain))
		await expect(relay('register', register('0'), '1.2.3.4', relayWith(chain))).rejects.toMatchObject({ status: 429 })
		await relay('register', register('0'), '5.6.7.8', relayWith(chain))
		await relay('register', register('10000'), '1.2.3.4', relayWith(chain))
	}, 60_000)

	it('sends a settle with the proof as given', async () => {
		const chain = fakeChain()
		const proof = { subject: H('88'), reader: PUBLISHER, merkleTreeDepth: '1', merkleTreeRoot: '2', nullifier: '3', points: ['1', '2', '3', '4', '5', '6', '7', '8'] }
		await relay('settle', proof, '1.2.3.4', relayWith(chain))
		expect(chain.sent[0].args).toEqual([H('88'), PUBLISHER, 1n, 2n, 3n, [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]])
	})
})
