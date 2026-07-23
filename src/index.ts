import {
	createPublicClient,
	http,
	keccak256,
	encodePacked,
	hexToBytes,
	bytesToHex,
	type Hex,
	type Address,
	recoverMessageAddress,
} from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { gcm } from '@noble/ciphers/aes.js'

// ------------------------------------------------------------
// The access worker is a key-release oracle, not a decryptor.
//
// Envelope model: episodes are AES-encrypted under a random 32-byte DEK. The
// big ciphertext lives in R2 keyed by `resourceId`. The DEK is sealed to THIS
// worker's static X25519 key (see fangorn `seal()`), and that sealed blob
// travels in the fangorn handle. The worker never touches plaintext:
//   GET  /pubkey        → the X25519 pubkey sellers seal DEKs to
//   GET  /ct/:id        → stream the (already-encrypted) R2 object; ungated
//   POST /access        → settlement-gated: unseal the DEK, return 32 bytes
// ------------------------------------------------------------

interface Env {
	BUCKET: R2Bucket
	SETTLEMENT_REGISTRY_ADDRESS: string
	ARBITRUM_SEPOLIA_RPC: string
	TIMESTAMP_WINDOW: string
	/** 32-byte X25519 secret (hex). `wrangler secret put WORKER_X25519_SECRET`. */
	WORKER_X25519_SECRET: string
}

interface AccessRequest {
	nullifier: string   // hex U256
	resourceId: string  // hex bytes32 — also the R2 object key
	timestamp: number   // unix seconds
	signature: Hex      // personal_sign over the packed message hash
}

/** R2 key holding the sealed DEK for a resource. Ciphertext lives at `resourceId`. */
const dekKey = (resourceId: string): string => `${resourceId}.dek`

const SETTLEMENT_REGISTRY_ABI = [
	{
		inputs: [
			{ internalType: 'address', name: 'stealth_address', type: 'address' },
			{ internalType: 'bytes32', name: 'resource_id', type: 'bytes32' },
		],
		name: 'isSettled',
		outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [{ internalType: 'bytes32', name: 'resource_id', type: 'bytes32' }],
		name: 'getPrice',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function',
	},
] as const

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function withCors(response: Response): Response {
	Object.entries(CORS_HEADERS).forEach(([k, v]) => response.headers.set(k, v))
	return response
}

function jsonError(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

// ------------------------------------------------------------
// Seal / unseal — worker-usdc-v1, byte-for-byte with fangorn's encryption.ts.
// Layout: ephemeralPub(32) || nonce(12) || aes-256-gcm(dek||tag)
// ------------------------------------------------------------

const X25519_PUBKEY_LENGTH = 32
const GCM_NONCE_LENGTH = 12

function sealInfo(resourceId: Hex): Uint8Array {
	const rid = hexToBytes(resourceId)
	const suffix = new TextEncoder().encode(':sealed')
	const out = new Uint8Array(rid.length + suffix.length)
	out.set(rid, 0)
	out.set(suffix, rid.length)
	return out
}

/**
 * Decode the worker's X25519 secret from env, accepting hex with or without a
 * `0x` prefix. viem's hexToBytes unconditionally slices off the first two
 * characters, so an unprefixed 64-char key silently becomes 31 bytes — validate
 * rather than let a malformed key reach key derivation.
 */
function workerSecret(env: Env): Uint8Array {
	const raw = (env.WORKER_X25519_SECRET ?? '').trim()
	const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw
	if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
		throw new Error('WORKER_X25519_SECRET must be 32 bytes of hex (64 hex chars; 0x optional)')
	}
	return hexToBytes(`0x${hex}`)
}

/** Recover the DEK sealed to this worker's key, bound to resourceId. Throws if the GCM tag fails. */
function unseal(sealed: Uint8Array, workerSecret: Uint8Array, resourceId: Hex): Uint8Array {
	const ephPub = sealed.slice(0, X25519_PUBKEY_LENGTH)
	const nonce = sealed.slice(X25519_PUBKEY_LENGTH, X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH)
	const aesCt = sealed.slice(X25519_PUBKEY_LENGTH + GCM_NONCE_LENGTH)
	const shared = x25519.getSharedSecret(workerSecret, ephPub)
	const aesKey = hkdf(sha256, shared, undefined, sealInfo(resourceId), 32)
	return gcm(aesKey, nonce).decrypt(aesCt)
}

// ------------------------------------------------------------
// Settlement verification
// ------------------------------------------------------------

/**
 * keccak256(abi.encodePacked(nullifier, resourceId, timestamp)) — the message
 * the buyer signs so we can recover the stealth address that settled.
 */
function buildMessageHash(
	req: Pick<AccessRequest, 'nullifier' | 'resourceId' | 'timestamp'>
): Hex {
	return keccak256(
		encodePacked(
			['uint256', 'bytes32', 'uint64'],
			[BigInt(req.nullifier), req.resourceId as Hex, BigInt(req.timestamp)]
		)
	)
}

async function verify(
	req: AccessRequest,
	env: Env
): Promise<{ ok: true; address: Address } | { ok: false; reason: string }> {
	const now = Math.floor(Date.now() / 1000)
	const window = parseInt(env.TIMESTAMP_WINDOW, 10)
	if (Math.abs(now - req.timestamp) > window) {
		return { ok: false, reason: `timestamp outside ${window}s window` }
	}

	let stealthAddress: Address
	try {
		stealthAddress = await recoverMessageAddress({
			message: { raw: buildMessageHash(req) },
			signature: req.signature,
		})
	} catch {
		return { ok: false, reason: 'invalid signature' }
	}

	const client = createPublicClient({
		chain: arbitrumSepolia,
		transport: http(env.ARBITRUM_SEPOLIA_RPC),
	})

	let price: bigint
	try {
		price = await client.readContract({
			address: env.SETTLEMENT_REGISTRY_ADDRESS as Address,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName: 'getPrice',
			args: [req.resourceId as Hex],
		})
	} catch (e) {
		console.error('price lookup failed:', e)
		return { ok: false, reason: 'price lookup failed' }
	}

	// Free resources release to any valid signer.
	if (price === 0n) return { ok: true, address: stealthAddress }

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

	if (!settled) return { ok: false, reason: 'not settled' }
	return { ok: true, address: stealthAddress }
}

// ------------------------------------------------------------
// Route: POST /access — settlement-gated DEK release
// ------------------------------------------------------------

async function handleAccess(request: Request, env: Env): Promise<Response> {
	let body: AccessRequest
	try {
		body = await request.json()
	} catch {
		return jsonError('invalid JSON body', 400)
	}

	if (!body.nullifier || !body.resourceId || !body.timestamp || !body.signature) {
		return jsonError('missing required fields: nullifier, resourceId, timestamp, signature', 400)
	}

	const result = await verify(body, env)
	if (!result.ok) return jsonError(result.reason, 403)

	const sealedObj = await env.BUCKET.get(dekKey(body.resourceId))
	if (!sealedObj) return jsonError('sealed DEK not found for resource', 404)
	const sealed = new Uint8Array(await sealedObj.arrayBuffer())

	let secret: Uint8Array
	try {
		secret = workerSecret(env)
	} catch (e) {
		console.error('bad worker secret:', e)
		return jsonError('worker misconfigured', 500)
	}

	let dek: Uint8Array
	try {
		dek = unseal(sealed, secret, body.resourceId as Hex)
	} catch (e) {
		// GCM tag failure ⇒ the stored DEK wasn't sealed to (this worker, this resourceId).
		console.error('unseal failed:', e)
		return jsonError('sealed DEK does not match this worker/resource', 500)
	}

	return new Response(JSON.stringify({ dek: bytesToHex(dek), address: result.address }), {
		status: 200,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
	})
}

// ------------------------------------------------------------
// Route: POST /upload/:resourceId — store ciphertext + sealed DEK
// ponytail: permissionless for testing; gate with an auth token before real use.
// ------------------------------------------------------------

async function handleUpload(request: Request, env: Env, resourceId: string): Promise<Response> {
	if (!request.body) return jsonError('empty body (expected ciphertext stream)', 400)

	const sealedHex = request.headers.get('X-Sealed-Dek')
	if (!sealedHex) return jsonError('missing X-Sealed-Dek header', 400)
	let sealed: Uint8Array
	try {
		sealed = hexToBytes(sealedHex as Hex)
	} catch {
		return jsonError('X-Sealed-Dek is not valid hex', 400)
	}

	try {
		await env.BUCKET.put(dekKey(resourceId), sealed)      // tiny; buffered
		await env.BUCKET.put(resourceId, request.body)        // big; streamed to R2
	} catch (e) {
		console.error('R2 put failed:', e)
		return jsonError('upload failed', 500)
	}

	return new Response(JSON.stringify({ resourceId }), {
		status: 201,
		headers: { 'Content-Type': 'application/json' },
	})
}

// ------------------------------------------------------------
// Route: GET /ct/:resourceId — stream the encrypted object (ungated; it's ciphertext)
// ------------------------------------------------------------

async function handleCiphertext(request: Request, env: Env, resourceId: string): Promise<Response> {
	const rangeHeader = request.headers.get('Range')
	let r2Range: R2Range | undefined
	if (rangeHeader) {
		const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
		if (match) {
			const offset = parseInt(match[1], 10)
			r2Range = match[2] ? { offset, length: parseInt(match[2], 10) - offset + 1 } : { offset }
		}
	}

	const object = await env.BUCKET.get(resourceId, r2Range ? { range: r2Range } : undefined)
	if (!object) return jsonError('ciphertext not found', 404)

	const headers: Record<string, string> = {
		'Content-Type': 'application/octet-stream',
		'Accept-Ranges': 'bytes',
	}
	if (r2Range && object.range) {
		const range = object.range as { offset?: number; length?: number }
		const offset = range.offset ?? 0
		const length = range.length ?? object.size - offset
		headers['Content-Range'] = `bytes ${offset}-${offset + length - 1}/${object.size}`
	}

	return new Response(object.body, { status: r2Range ? 206 : 200, headers })
}

// ------------------------------------------------------------
// Router
// ------------------------------------------------------------

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const { method } = request
		const pathname = url.pathname

		if (method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS })

		if (method === 'GET') {
			if (pathname === '/pubkey') {
				try {
					const pub = x25519.getPublicKey(workerSecret(env))
					return withCors(
						new Response(JSON.stringify({ pubkey: bytesToHex(pub) }), {
							headers: { 'Content-Type': 'application/json' },
						})
					)
				} catch (e) {
					console.error('bad worker secret:', e)
					return withCors(jsonError('worker misconfigured', 500))
				}
			}
			if (pathname.startsWith('/ct/')) {
				return withCors(await handleCiphertext(request, env, decodeURIComponent(pathname.slice(4))))
			}
		}

		if (method === 'POST') {
			if (pathname === '/access') return withCors(await handleAccess(request, env))
			if (pathname.startsWith('/upload/')) {
				return withCors(await handleUpload(request, env, decodeURIComponent(pathname.slice(8))))
			}
		}

		return jsonError('not found', 404)
	},
}
