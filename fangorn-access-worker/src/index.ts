import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, createPublicClient, hexToBytes, http, type Address } from 'viem'
import getNetwork, { FangornConfig } from '@fangorn-network/sdk/lib/config.js'
import type { AccessRequest } from '@fangorn-network/sdk/lib/crypto/paid.js'
import { AccessError, serveAccess } from './access'
import { SettlementRegistryClient } from '@fangorn-network/sdk/lib/contracts/settlement-registry/index.js'

// Key server for paid fields. Stores nothing.
//   GET  /pubkey  key that publishers seal @deposit records to
//   POST /access  buyer sends the deposit + a signed request; gets the record key if canRead

interface Env {
	WORKER_X25519_SECRET: string // 32 bytes hex. Lose it and every deposit is unopenable.
	RPC_URL?: string
	// The SDK's network name ("baseSepolia", "arbitrumSepolia"); unset, its default.
	NETWORK?: string
	SETTLEMENT_REGISTRY?: string
}

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

function secret(env: Env): Uint8Array {
	const hex = (env.WORKER_X25519_SECRET ?? '').trim().replace(/^0x/i, '')
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('WORKER_X25519_SECRET must be 32 bytes of hex')
	return hexToBytes(`0x${hex}`)
}

const isHex = (v: unknown, bytes?: number) =>
	typeof v === 'string' && /^0x([0-9a-fA-F]{2})+$/.test(v) && (!bytes || v.length === 2 + bytes * 2)

function wellFormed(b: AccessRequest | null): b is AccessRequest {
	return (
		!!b &&
		isHex(b.publisher, 20) &&
		isHex(b.repo, 32) &&
		isHex(b.key, 32) &&
		isHex(b.readerKey, 32) &&
		isHex(b.sealed) &&
		isHex(b.signature) &&
		/^\d{1,20}$/.test(String(b.generation)) &&
		Number.isSafeInteger(b.timestamp)
	)
}

async function access(request: Request, env: Env): Promise<Response> {
	const body = (await request.json().catch(() => null)) as AccessRequest | null
	if (!wellFormed(body)) return json({ error: 'malformed request' }, 400)

	const net = env.NETWORK ? getNetwork(env.NETWORK) : FangornConfig
	const registry = new SettlementRegistryClient(
		(env.SETTLEMENT_REGISTRY || net.settlementRegistryContractAddress) as Address,
		createPublicClient({ transport: http(env.RPC_URL || net.rpcUrl) }) as never,
	)
	try {
		return json(
			await serveAccess(body, {
				secret: secret(env),
				chainId: net.chain.id,
				registry: registry.getAddress(),
				canRead: (reader, publisher, repo, key) => registry.canRead(reader, publisher, repo, key),
			}),
		)
	} catch (e) {
		if (e instanceof AccessError) return json({ error: e.message }, e.status)
		console.error(e)
		return json({ error: 'key server error' }, 502)
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const { pathname } = new URL(request.url)
		if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
		if (request.method === 'GET' && pathname === '/pubkey') {
			try {
				return json({ pubkey: bytesToHex(x25519.getPublicKey(secret(env))) })
			} catch (e) {
				console.error(e)
				return json({ error: 'worker misconfigured' }, 500)
			}
		}
		if (request.method === 'POST' && pathname === '/access') return access(request, env)
		return json({ error: 'not found' }, 404)
	},
}
