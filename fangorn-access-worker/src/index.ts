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
	/** 32-byte X25519 secret (hex). Optional — minted into the bucket if unset. */
	WORKER_X25519_SECRET?: string
	/** Pins the upload token. Optional — the bucket is claimed on first upload if unset. */
	UPLOAD_TOKEN?: string
}

interface AccessRequest {
	nullifier: string   // hex U256
	resourceId: string  // hex bytes32 — also the R2 object key
	timestamp: number   // unix seconds
	signature: Hex      // personal_sign over the packed message hash
}

/** R2 key holding the sealed DEK for a resource. Ciphertext lives at `resourceId`. */
const dekKey = (resourceId: string): string => `${resourceId}.dek`

/** R2 key holding this worker's minted X25519 secret. See `workerSecret`. */
const SECRET_KEY = '.worker-x25519-secret'

/**
 * Every legitimate object key is a bytes32: `resourceId` for chunk 0,
 * `keccak256(resourceId ++ uint32 i)` for the rest (see `chunkKey` in
 * sond3r's src/buy.js and server/settle.js, which must agree).
 *
 * This is a security boundary, not tidiness. `/ct/` is ungated because
 * ciphertext is safe to hand out — but the bucket also holds `<id>.dek` and
 * `.worker-x25519-secret`, and without this an unauthenticated
 * `GET /ct/.worker-x25519-secret` would serve the private key that opens every
 * DEK in the bucket.
 */
const isObjectKey = (key: string): boolean => /^0x[0-9a-f]{64}$/.test(key)

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

/** `reason` is a machine-readable code for the caller to branch on — sond3r's
 *  relay turns it into the right instruction instead of listing every cause. */
function jsonError(message: string, status: number, reason?: string): Response {
	return new Response(JSON.stringify({ error: message, ...(reason ? { reason } : {}) }), {
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
 * This worker's X25519 identity — the key every DEK in this bucket is sealed to.
 *
 * `WORKER_X25519_SECRET` wins when set. The shared deployment already has DEKs
 * sealed to a secret installed with `wrangler secret put`, and minting a new one
 * would strand every resource already published to it.
 *
 * With no secret set, mint one into the bucket. A publisher deploying their own
 * worker from the Deploy to Cloudflare button gets a working worker with no
 * setup step — the button can prompt for secrets, but "paste 32 bytes of hex" is
 * exactly the friction that stops a publisher who does not know what R2 is.
 * The key never leaves their own Cloudflare account either way.
 *
 * Any 32 random bytes is a valid X25519 scalar; clamping happens in the curve.
 */
async function workerSecret(env: Env): Promise<Uint8Array> {
	const raw = (env.WORKER_X25519_SECRET ?? '').trim()
	if (raw) {
		// viem's hexToBytes unconditionally slices off the first two characters, so
		// an unprefixed 64-char key silently becomes 31 bytes — validate rather than
		// let a malformed key reach key derivation.
		const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw
		if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
			throw new Error('WORKER_X25519_SECRET must be 32 bytes of hex (64 hex chars; 0x optional)')
		}
		return hexToBytes(`0x${hex}`)
	}

	const existing = await env.BUCKET.get(SECRET_KEY)
	if (existing) return new Uint8Array(await existing.arrayBuffer())

	// `etagDoesNotMatch: '*'` means "only if absent". Two cold requests racing
	// would otherwise each mint a key and overwrite the other — and every DEK
	// sealed to the loser becomes permanently unopenable. On a lost race, put()
	// returns null and we read the winner's key instead of our own.
	const minted = crypto.getRandomValues(new Uint8Array(32))
	const won = await env.BUCKET.put(SECRET_KEY, minted, { onlyIf: { etagDoesNotMatch: '*' } })
	if (won) return minted

	const theirs = await env.BUCKET.get(SECRET_KEY)
	if (!theirs) throw new Error('could not mint or read the worker secret')
	return new Uint8Array(await theirs.arrayBuffer())
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
		secret = await workerSecret(env)
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
// ------------------------------------------------------------

/** R2 key holding the SHA-256 of the token allowed to upload. See `authorizeUpload`. */
const TOKEN_KEY = '.upload-token'

const sha256Hex = async (s: string): Promise<string> =>
	bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))

/**
 * Uploads are gated, and the gate installs itself on first use.
 *
 * `UPLOAD_TOKEN` wins when set — that is how the shared deployment is pinned.
 * Otherwise the FIRST upload to a fresh bucket claims it: whatever token it
 * presents is hashed and stored, and every later upload must match. A publisher
 * deploying their own worker never sets anything; sond3r mints a token and
 * claims the worker the moment they connect it (see POST /api/worker there).
 *
 * The exposure is the gap between `wrangler deploy` and that first claim, which
 * is seconds and ends the first time the real publisher uploads. Being
 * permissionless — the previous behaviour — meant anyone who learned the URL
 * could overwrite a publisher's ciphertext forever.
 */
async function authorizeUpload(request: Request, env: Env): Promise<boolean> {
	const presented = (request.headers.get('Authorization') ?? '').replace(/^Bearer /i, '').trim()
	if (!presented) return false

	const pinned = (env.UPLOAD_TOKEN ?? '').trim()
	if (pinned) return presented === pinned

	const digest = await sha256Hex(presented)
	const claimed = await env.BUCKET.get(TOKEN_KEY)
	if (claimed) return (await claimed.text()) === digest

	// Unclaimed bucket: this token becomes the owner. `etagDoesNotMatch: '*'`
	// makes the claim atomic, so two racers cannot both believe they won.
	const won = await env.BUCKET.put(TOKEN_KEY, digest, { onlyIf: { etagDoesNotMatch: '*' } })
	if (won) return true
	const theirs = await env.BUCKET.get(TOKEN_KEY)
	return theirs ? (await theirs.text()) === digest : false
}

/** R2 key holding the ETH address allowed to rotate the upload token. See `handleClaim`. */
const OWNER_KEY = '.upload-owner'

/** The exact string a publisher's wallet signs to claim this bucket. sond3r's
 *  relay builds the identical string (server/index.js, `claimMessage`) — they
 *  must agree byte-for-byte or every claim recovers a different address. */
const claimMessage = (digest: string, timestamp: number): string =>
	`sond3r storage claim\ntoken: ${digest}\ntime: ${timestamp}`

/** Wider than TIMESTAMP_WINDOW: a claim waits on a wallet popup, /access doesn't. */
const CLAIM_WINDOW = 600

/**
 * POST /claim — install or ROTATE this bucket's upload token, with no wrangler.
 *
 * The token alone can't authorize rotating itself (a publisher who lost it is
 * exactly who needs to rotate), so the authority is the publisher's wallet: the
 * first claim records the signing address in `.upload-owner`, and afterwards
 * only that address can point the bucket at a different token. Rotating
 * ETH_PRIVATE_KEY on the relay — which changes the derived token and used to
 * strand the bucket behind `wrangler r2 object delete` — is now a re-Connect.
 *
 * Presenting the token that already won needs no signature, so this stays
 * idempotent for the ordinary connect-again case.
 *
 * ponytail: a bucket claimed BEFORE this shipped has no `.upload-owner`, so the
 * first valid signature adopts it. That reopens the same land-grab window a
 * fresh bucket already has, once, for legacy buckets only — the alternative is
 * leaving them permanently stranded, which is the bug being fixed.
 */
async function handleClaim(request: Request, env: Env): Promise<Response> {
	const presented = (request.headers.get('Authorization') ?? '').replace(/^Bearer /i, '').trim()
	if (!presented) return jsonError('missing upload token', 401, 'missing-token')

	const pinned = (env.UPLOAD_TOKEN ?? '').trim()
	if (pinned) {
		// A pinned worker accepts nothing else, and no signature can override it —
		// the secret is Cloudflare-account state, not bucket state.
		return presented === pinned
			? new Response(JSON.stringify({ claimed: true }), { headers: { 'Content-Type': 'application/json' } })
			: jsonError('this worker pins an UPLOAD_TOKEN secret, and this is not it', 401, 'pinned')
	}

	const digest = await sha256Hex(presented)
	const claimed = await env.BUCKET.get(TOKEN_KEY)
	if (claimed && (await claimed.text()) === digest) {
		return new Response(JSON.stringify({ claimed: true }), { headers: { 'Content-Type': 'application/json' } })
	}

	const body = (await request.json().catch(() => ({}))) as { timestamp?: number; signature?: Hex }
	const timestamp = Number(body.timestamp)
	if (!body.signature || !Number.isFinite(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > CLAIM_WINDOW) {
		return jsonError('this bucket is claimed by a different token — sign to take it over', 401, 'needs-signature')
	}

	let signer: Address
	try {
		signer = await recoverMessageAddress({ message: claimMessage(digest, timestamp), signature: body.signature })
	} catch {
		return jsonError('invalid claim signature', 401, 'needs-signature')
	}

	let owner = await env.BUCKET.get(OWNER_KEY).then((o) => o?.text())
	if (!owner) {
		// `etagDoesNotMatch: '*'` makes first-owner atomic, so two racers cannot
		// both believe they won.
		const won = await env.BUCKET.put(OWNER_KEY, signer, { onlyIf: { etagDoesNotMatch: '*' } })
		owner = won ? signer : await env.BUCKET.get(OWNER_KEY).then((o) => o?.text())
	}
	if (owner?.toLowerCase() !== signer.toLowerCase()) {
		return jsonError(`this bucket belongs to ${owner} — connect with that wallet`, 401, 'not-owner')
	}

	await env.BUCKET.put(TOKEN_KEY, digest)
	return new Response(JSON.stringify({ claimed: true, owner }), { headers: { 'Content-Type': 'application/json' } })
}

async function handleUpload(request: Request, env: Env, resourceId: string): Promise<Response> {
	if (!isObjectKey(resourceId)) return jsonError('resourceId must be 32 bytes of hex', 400)
	if (!(await authorizeUpload(request, env))) {
		return jsonError('missing or incorrect upload token', 401)
	}
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
	if (!isObjectKey(resourceId)) return jsonError('not found', 404)

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
					const pub = x25519.getPublicKey(await workerSecret(env))
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
			// Claim the bucket without uploading, so a publisher connecting a fresh
			// worker closes the unclaimed window at connect time rather than at
			// first publish. Idempotent: re-presenting the winning token succeeds.
			if (pathname === '/claim') return withCors(await handleClaim(request, env))
			if (pathname.startsWith('/upload/')) {
				return withCors(await handleUpload(request, env, decodeURIComponent(pathname.slice(8))))
			}
		}

		return jsonError('not found', 404)
	},
}
