import {
	createPublicClient,
	http,
	recoverAddress,
	keccak256,
	encodePacked,
	type Hex,
	type Address,
	recoverMessageAddress,
} from 'viem'
import { arbitrumSepolia } from 'viem/chains'

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------

interface Env {
	BUCKET: R2Bucket
	SETTLEMENT_REGISTRY_ADDRESS: string
	ARBITRUM_SEPOLIA_RPC: string
	TIMESTAMP_WINDOW: string
}

interface AccessRequest {
	nullifier: string   // hex U256
	resourceId: string  // hex bytes32
	objectKey: string   // R2 object key e.g. "tracks/audio.mp3"
	timestamp: number   // unix seconds
	signature: Hex      // personal_sign over packed message hash
}

const SETTLEMENT_REGISTRY_ABI = [
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "stealth_address",
				"type": "address"
			},
			{
				"internalType": "bytes32",
				"name": "resource_id",
				"type": "bytes32"
			}
		],
		"name": "isSettled",
		"outputs": [
			{
				"internalType": "bool",
				"name": "",
				"type": "bool"
			}
		],
		"stateMutability": "view",
		"type": "function"
	}
] as const

/**
 * Build the message hash the client must have signed.
 *
 * keccak256(abi.encodePacked(nullifier, resourceId, objectKey, timestamp))
 *
 * Clients sign with walletClient.signMessage({ message: { raw: msgHash } })
 * which applies the EIP-191 prefix. recoverAddress() expects the raw hash
 * and handles the prefix internally.
 */
function buildMessageHash(
	req: Pick<AccessRequest, 'nullifier' | 'resourceId' | 'objectKey' | 'timestamp'>
): Hex {
	return keccak256(
		encodePacked(
			['uint256', 'bytes32', 'string', 'uint64'],
			[
				BigInt(req.nullifier),
				req.resourceId as Hex,
				req.objectKey,
				BigInt(req.timestamp),
			]
		)
	)
}

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

/**
 * 
 * @param req 
 * @param env 
 * @returns 
 */
async function verify(
	req: AccessRequest,
	env: Env
): Promise<{ ok: true; address: Address } | { ok: false; reason: string }> {

	// 1. Timestamp freshness
	const now = Math.floor(Date.now() / 1000)
	const window = parseInt(env.TIMESTAMP_WINDOW, 10)
	if (Math.abs(now - req.timestamp) > window) {
		return { ok: false, reason: `timestamp outside ${window}s window` }
	}

	// 2. Recover stealth address from signature
	const msgHash = buildMessageHash(req)
	let stealthAddress: Address
	try {
		stealthAddress = await recoverMessageAddress({
			message: { raw: msgHash },
			signature: req.signature
		})

		console.log('we got the address ' + stealthAddress)
	} catch {
		return { ok: false, reason: 'invalid signature' }
	}

	// 3. Verify settlement on-chain
	const client = createPublicClient({
		chain: arbitrumSepolia,
		transport: http(env.ARBITRUM_SEPOLIA_RPC),
	})

	let settled: boolean
	try {
		settled = await client.readContract({
			address: env.SETTLEMENT_REGISTRY_ADDRESS as Address,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: 'isSettled',
			args: [stealthAddress, req.resourceId as Hex],
		})
	} catch (e) {
		console.error('RPC error:', e)
		return { ok: false, reason: 'settlement check failed' }
	}

	if (!settled) {
		return { ok: false, reason: 'not settled' }
	}

	return { ok: true, address: stealthAddress }
}

/**
 * 
 * @param request 
 * @param env 
 * @returns 
 */
async function handleAccess(request: Request, env: Env): Promise<Response> {

	if (!env.BUCKET) {
		return jsonError('R2 bucket not bound — check wrangler.toml and restart with --local', 500)
	}

	let body: AccessRequest
	try {
		body = await request.json()
	} catch {
		return jsonError('invalid JSON body', 400)
	}

	if (
		!body.nullifier ||
		!body.resourceId ||
		!body.objectKey ||
		!body.timestamp ||
		!body.signature
	) {
		return jsonError(
			'missing required fields: nullifier, resourceId, objectKey, timestamp, signature',
			400
		)
	}

	const result = await verify(body, env)
	if (!result.ok) {
		return jsonError(result.reason, 401)
	}

	const object = await env.BUCKET.get(body.objectKey)
	if (!object) {
		return jsonError('object not found', 404)
	}

	const contentType =
		object.httpMetadata?.contentType ?? 'application/octet-stream'

	return new Response(object.body, {
		status: 200,
		headers: {
			'Content-Type': contentType,
			'Cache-Control': 'private, no-store',
			'X-Fangorn-Address': result.address,
		},
	})
}

// handle CORS
const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: CORS_HEADERS })
		}

		if (request.method === 'POST' && url.pathname === '/access') {
			const response = await handleAccess(request, env)
			Object.entries(CORS_HEADERS).forEach(([k, v]) =>
				response.headers.set(k, v)
			)
			return response
		}

		return jsonError('not found', 404)
	},
}