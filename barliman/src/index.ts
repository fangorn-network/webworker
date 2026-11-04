import { createPublicClient, createWalletClient, http, isAddress, zeroAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { FangornConfig } from '@fangorn-network/sdk/lib/config.js'
import { relay, RelayError, type Chain, type Relay } from './relay'
import * as x402 from './x402'

// Barliman: the treasury pays gas for transactions others signed.
//   POST /relay/commit|register|settle   the relay (src/relay.ts)
//   POST /verify, POST /settle, GET /supported   x402 facilitator for buying a record (src/x402.ts)

interface Env {
	TREASURY_KEY: Hex // secret: pays the gas
	TREASURY: Address // the referrer on every register
	RATE_KV: KVNamespace
	RPC_URL?: string
	// For a devnet or another deployment; unset, the SDK's.
	DATA_REGISTRY?: Address
	SETTLEMENT_REGISTRY?: Address
}

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// ponytail: each send asks the RPC for the next nonce, so two sends at the same instant can collide
// and one fails. Serialize sends through a Durable Object if that shows up.
function chainOf(env: Env): Chain {
	const transport = http(env.RPC_URL || FangornConfig.rpcUrl)
	const account = privateKeyToAccount(env.TREASURY_KEY)
	const pub = createPublicClient({ chain: FangornConfig.chain, transport })
	const wallet = createWalletClient({ account, chain: FangornConfig.chain, transport })
	return {
		simulate: async (call) => (await pub.simulateContract({ ...call, account } as never)).request,
		send: (request) => wallet.writeContract(request as never),
	}
}

const NETWORK = `eip155:${FangornConfig.chain.id}` as const

function relayOf(env: Env): Relay {
	return {
		chain: chainOf(env),
		kv: env.RATE_KV,
		treasury: env.TREASURY,
		dataRegistry: env.DATA_REGISTRY || (FangornConfig.dataRegistryContractAddress as Address),
		settlementRegistry: env.SETTLEMENT_REGISTRY || (FangornConfig.settlementRegistryContractAddress as Address),
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
		const path = new URL(request.url).pathname
		if (request.method === 'GET' && path === '/supported') return json(x402.supported(NETWORK, env.TREASURY))

		const route = path.match(/^\/relay\/(commit|register|settle)$/)?.[1]
		const facilitator = path === '/verify' || path === '/settle'
		if (request.method !== 'POST' || (!route && !facilitator)) return json({ error: 'not found' }, 404)

		// Without a real treasury address every register would pay its 5% to nobody.
		if (!isAddress(env.TREASURY) || env.TREASURY === zeroAddress) return json({ error: 'worker misconfigured: TREASURY' }, 500)

		const body = await request.json().catch(() => null)
		try {
			if (path === '/verify') return json(await x402.verify(body, relayOf(env), NETWORK))
			if (path === '/settle') return json(await x402.settle(body, relayOf(env), NETWORK))
			return json(await relay(route!, body, request.headers.get('CF-Connecting-IP') ?? 'unknown', relayOf(env)))
		} catch (e) {
			if (e instanceof RelayError) return json({ error: e.message }, e.status)
			console.error(e)
			return json({ error: 'relay failed' }, 502)
		}
	},
}
