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
// One worker, one bucket, EVERY publisher. Keys never collide because they are
// already derived from the publisher's address, and writes are attributed and
// re-checked per object — see `uploadOwner` and `mayTouch`.
//
// Envelope model: episodes are AES-encrypted under a random 32-byte DEK. The
// big ciphertext lives in R2 keyed by `resourceId`. The DEK is sealed to THIS
// worker's static X25519 key (see fangorn `seal()`), and that sealed blob
// travels in the fangorn handle. The worker never touches plaintext:
//   GET  /pubkey        → the X25519 pubkey sellers seal DEKs to
//   GET  /ct/:id        → stream the (already-encrypted) R2 object; ungated
//   POST /access        → settlement-gated: unseal the DEK, return 32 bytes
//
// The gate, in order (see `verify`): the resource must exist, must not be
// disabled, and — if it costs anything — must have been settled by the address
// that signed the request. The disabled check lives here and nowhere else: the
// registry keeps `isSettled` true after a takedown because the payment really
// happened, so refusing a taken-down resource is this worker's job.
// ------------------------------------------------------------

interface Env {
	BUCKET: R2Bucket
	SETTLEMENT_REGISTRY_ADDRESS: string
	ARBITRUM_SEPOLIA_RPC: string
	TIMESTAMP_WINDOW: string
	/** 32-byte X25519 secret (hex). Optional — minted into the bucket if unset. */
	WORKER_X25519_SECRET?: string
	/** 32 bytes of hex, shared with the relay that mints upload tokens. REQUIRED to upload. */
	UPLOAD_HMAC_SECRET?: string
	/** Free bytes per wallet. Optional — defaults to 50 MiB. */
	FREE_BYTES?: string
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
	{
		inputs: [{ internalType: 'bytes32', name: 'resource_id', type: 'bytes32' }],
		name: 'getOwner',
		outputs: [{ internalType: 'address', name: '', type: 'address' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [{ internalType: 'bytes32', name: 'resource_id', type: 'bytes32' }],
		name: 'isDisabled',
		outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
		stateMutability: 'view',
		type: 'function',
	},
] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	// X-Sealed-Dek is here because publishers encrypt and upload from the BROWSER
	// now, not from a relay. Without it every direct upload dies on preflight, and
	// the error the publisher sees names CORS rather than anything they can fix.
	'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sealed-Dek',
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

	const read = <T>(functionName: string, args: readonly unknown[]) =>
		client.readContract({
			address: env.SETTLEMENT_REGISTRY_ADDRESS as Address,
			abi: SETTLEMENT_REGISTRY_ABI,
			functionName,
			args,
		} as never) as Promise<T>

	let owner: Address, price: bigint, disabled: boolean
	try {
		;[owner, price, disabled] = await Promise.all([
			read<Address>('getOwner', [req.resourceId as Hex]),
			read<bigint>('getPrice', [req.resourceId as Hex]),
			read<boolean>('isDisabled', [req.resourceId as Hex]),
		])
	} catch (e) {
		console.error('resource lookup failed:', e)
		return { ok: false, reason: 'resource lookup failed' }
	}

	// An unregistered resource has no owner — and, being unregistered, also has a
	// price of zero. Checking the price first would read that as "free" and hand
	// the DEK to anyone, for any object in the bucket the registry has never
	// heard of. Existence is the first question, not the second.
	if (owner === ZERO_ADDRESS) return { ok: false, reason: 'unknown resource' }

	// Takedown. The registry deliberately does NOT un-settle anyone — `isSettled`
	// stays true because the payment is a historical fact — so a disabled
	// resource is refused HERE or not at all, and it has to be refused to buyers
	// who already settled, which is the only case that matters.
	if (disabled) return { ok: false, reason: 'resource disabled' }

	// Free resources release to any valid signer.
	if (price === 0n) return { ok: true, address: stealthAddress }

	let settled: boolean
	try {
		settled = await read<boolean>('isSettled', [stealthAddress, req.resourceId as Hex])
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

// ------------------------------------------------------------
// Who is uploading — one shared bucket, many publishers.
//
// "Does the caller hold this bucket's token" stopped being a useful question the
// moment one bucket started serving everybody. So the token NAMES ITS BEARER:
//
//     Authorization: Bearer <owner>.<keccak256(secret ++ owner)>
//
// `secret` is UPLOAD_HMAC_SECRET, shared with the relay that mints the tokens
// (sond3r's server/index.js, `uploadTokenFor`) and with nothing else. Verifying
// it recovers the owner address with no bucket state and no round trip, which is
// what lets a publisher who has never touched this worker upload immediately —
// and what replaced the first-upload-claims-the-bucket dance, which could only
// ever hold one publisher.
//
// Every key the relay writes is already derived from the owner address
// (`resourceIdFor(owner, uid)`, `manifestKey(owner)` in sond3r's src/envelope.js
// and src/encrypt.js), so two publishers cannot collide by accident. What one
// COULD do on purpose is overwrite: uids are public, so anyone can compute
// anyone's resourceId. Hence the owner is stamped on every object as R2 custom
// metadata and re-checked on every write, delete and read-back.
// ------------------------------------------------------------

/** Byte-for-byte with sond3r's `uploadTokenFor` (server/index.js). */
const macFor = (secret: Hex, owner: Address): string =>
	keccak256(encodePacked(['bytes32', 'address'], [secret, owner]))

/** Length-independent compare, so a near-miss MAC leaks no prefix. */
function sameMac(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

/**
 * The publisher this request is authorized as, lowercased, or null.
 *
 * A worker with no (or a malformed) UPLOAD_HMAC_SECRET authorizes NOBODY. Every
 * other failure mode here is a misconfiguration that would otherwise open a
 * bucket the operator pays for to anyone who learned the URL.
 */
function uploadOwner(request: Request, env: Env): Address | null {
	const secret = (env.UPLOAD_HMAC_SECRET ?? '').trim()
	if (!/^0x[0-9a-fA-F]{64}$/.test(secret)) return null
	const [owner, mac] = (request.headers.get('Authorization') ?? '').replace(/^Bearer /i, '').trim().split('.')
	if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? '') || !mac) return null
	const lower = owner.toLowerCase() as Address
	return sameMac(mac.toLowerCase(), macFor(secret as Hex, lower)) ? lower : null
}

/** R2 custom metadata key: which publisher put these bytes here. */
const OWNER_META = 'owner'
const ownerMeta = (owner: Address) => ({ customMetadata: { [OWNER_META]: owner } })

/**
 * Whether `owner` may write, delete or read back `key`.
 *
 * A key nobody has written is free to claim; after that it is that publisher's
 * for good. First-writer-wins means a publisher COULD squat a rival's future
 * resourceId, but only by guessing a uid before it exists — whereas the
 * alternative, trusting the derivation, lets anyone overwrite any published file
 * in the bucket.
 *
 * An existing object with NO owner metadata predates the shared bucket. There is
 * nobody to attribute it to, so it is refused rather than adopted: adopting it
 * would hand the first caller who asked whatever the old deployment left behind.
 *
 * ponytail: one HEAD per object touched, and last-writer-wins on a genuine race
 * for a fresh key. Both are fine at one publisher per key; if concurrent claims
 * ever matter, put() with `onlyIf: { etagDoesNotMatch: '*' }` for the first write.
 */
const owned = (head: R2Object | null, owner: Address): boolean =>
	!head || head.customMetadata?.[OWNER_META] === owner

async function mayTouch(env: Env, key: string, owner: Address): Promise<boolean> {
	return owned(await env.BUCKET.head(key), owner)
}

// ------------------------------------------------------------
// The free tier — every wallet, no registration, no bill.
//
// Holding a valid token is no longer a statement that anyone vouched for the
// bearer: the relay mints one for any signed-in wallet, so the only thing left
// standing between a stranger and the operator's R2 bill is this cap. It is
// metered per owner, in the bucket, beside the bytes it meters.
//
// `usage/<owner>` is deliberately NOT a bytes32, so `isObjectKey` keeps the
// ungated /ct/ route from serving it.
// ------------------------------------------------------------

const DEFAULT_FREE_BYTES = 50 * 1024 * 1024

const freeBytes = (env: Env): number => Number(env.FREE_BYTES) || DEFAULT_FREE_BYTES

const usageKey = (owner: Address): string => `usage/${owner}`

async function usedBytes(env: Env, owner: Address): Promise<number> {
	const obj = await env.BUCKET.get(usageKey(owner))
	return obj ? Number(await obj.text()) || 0 : 0
}

/**
 * ponytail: read-modify-write, so two uploads racing from ONE wallet can both
 * read the same total and one increment is lost — that wallet ends up
 * undercounted by a file, never overcharged, and the next upload reads the
 * survivor. R2 has no counter primitive; a Durable Object per owner is the
 * upgrade if free storage ever becomes worth gaming.
 */
async function addUsage(env: Env, owner: Address, delta: number): Promise<void> {
	const next = Math.max(0, (await usedBytes(env, owner)) + delta)
	await env.BUCKET.put(usageKey(owner), String(next))
}

async function handleUpload(request: Request, env: Env, resourceId: string): Promise<Response> {
	if (!isObjectKey(resourceId)) return jsonError('resourceId must be 32 bytes of hex', 400)
	const owner = uploadOwner(request, env)
	if (!owner) return jsonError('missing or incorrect upload token', 401)
	const previous = await env.BUCKET.head(resourceId)
	if (!owned(previous, owner)) return jsonError('this object belongs to another publisher', 403)
	if (!request.body) return jsonError('empty body (expected ciphertext stream)', 400)

	// Checked against the DECLARED length before a byte is streamed, so a wallet
	// already at its cap is refused up front instead of after paying for the
	// transfer. The real size is what gets recorded below, so a client that lies
	// here overshoots by at most one file and is then locked out.
	const limit = freeBytes(env)
	const used = await usedBytes(env, owner)
	const budget = limit - used + (previous?.size ?? 0)
	const declared = Number(request.headers.get('Content-Length') ?? 0)
	if (declared > budget) {
		return jsonError(`free storage exhausted: ${used} of ${limit} bytes used`, 413, 'quota')
	}

	// Absent DEK = the object is the publisher's OWN state (sond3r keeps its
	// per-publisher manifest here), not ciphertext anyone will ever buy. It is
	// stored as-is and no DEK object is written, so /access has nothing to
	// release and the settlement path cannot hand it out. Anything a buyer pays
	// for still arrives with a DEK, because encryptAndUpload always sends one.
	const sealedHex = request.headers.get('X-Sealed-Dek')
	let sealed: Uint8Array | null = null
	if (sealedHex) {
		try {
			sealed = hexToBytes(sealedHex as Hex)
		} catch {
			return jsonError('X-Sealed-Dek is not valid hex', 400)
		}
	}

	try {
		if (sealed) await env.BUCKET.put(dekKey(resourceId), sealed, ownerMeta(owner))  // tiny; buffered
		else await env.BUCKET.delete(dekKey(resourceId))                               // no stale DEK from a previous life of this key
		const written = await env.BUCKET.put(resourceId, request.body, ownerMeta(owner)) // big; streamed to R2
		await addUsage(env, owner, (written?.size ?? declared) - (previous?.size ?? 0))
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
// Route: DELETE /upload/:resourceId — drop an object and its sealed DEK
//
// Same path and same gate as upload, because it is the same authority: whoever
// holds the bucket's upload token put these bytes here and is the only one who
// may take them away — which on a shared bucket means the publisher the token
// names, not merely whoever holds a token. An ungated delete would let anyone
// empty a publisher's library over HTTP; a token-only gate would let any OTHER
// publisher do it.
//
// Chunked resources are deleted one key at a time by the caller, which knows the
// chunk count (sond3r's server/settle.js chunkKey). The worker deliberately does
// not walk or guess the chunk list: `isObjectKey` is what keeps this route away
// from `.worker-x25519-secret`, and it only holds because every key it accepts
// is a literal bytes32. A "delete all chunks of X" route
// would have to synthesize keys, and a bug there deletes the wrong publisher's
// objects.
//
// Idempotent: R2 delete succeeds on a key that isn't there, so a retry after a
// half-finished delete is safe and a caller can always just try again.
// ------------------------------------------------------------

async function handleDelete(request: Request, env: Env, resourceId: string): Promise<Response> {
	if (!isObjectKey(resourceId)) return jsonError('resourceId must be 32 bytes of hex', 400)
	const owner = uploadOwner(request, env)
	if (!owner) return jsonError('missing or incorrect upload token', 401)
	// Without this, one publisher could empty another's library out of the bucket
	// they share — the delete gate is now ownership, not merely "holds a token".
	const existing = await env.BUCKET.head(resourceId)
	if (!owned(existing, owner)) return jsonError('this object belongs to another publisher', 403)
	try {
		// The DEK goes with the ciphertext. Leaving it behind would keep releasing
		// a key for bytes that no longer exist.
		await env.BUCKET.delete([resourceId, dekKey(resourceId)])
		// Deleting has to give the quota back, or the free tier is a lifetime
		// total and a publisher who tidies up gets nothing for it.
		if (existing) await addUsage(env, owner, -existing.size)
	} catch (e) {
		console.error('R2 delete failed:', e)
		return jsonError('delete failed', 500)
	}
	return new Response(JSON.stringify({ deleted: resourceId }), {
		headers: { 'Content-Type': 'application/json' },
	})
}

// ------------------------------------------------------------
// Route: GET /upload/:resourceId — read an object back, upload token required
//
// The mirror of POST /upload, and gated the same way for the same reason: this
// hands back raw stored bytes, so the only caller allowed is whoever put them
// there. GET /ct/ cannot serve this job — it is deliberately ungated because
// everything under it is ciphertext, and the publisher state read through here
// is not.
//
// It exists so a publisher's manifest can live in their OWN bucket instead of on
// the relay's disk. The relay stages nothing and stores nothing per publisher;
// this is how the library comes back on a different machine.
// ------------------------------------------------------------

async function handleFetchOwn(request: Request, env: Env, resourceId: string): Promise<Response> {
	if (!isObjectKey(resourceId)) return jsonError('resourceId must be 32 bytes of hex', 400)
	const owner = uploadOwner(request, env)
	if (!owner) return jsonError('missing or incorrect upload token', 401)
	// A publisher's manifest is read through here, and on a shared bucket that
	// makes ownership the gate: holding a valid token proves who you are, not
	// that you may read someone else's library.
	if (!(await mayTouch(env, resourceId, owner))) return jsonError('this object belongs to another publisher', 403)
	const object = await env.BUCKET.get(resourceId)
	// 404, not an error: "this publisher has no manifest yet" is the ordinary
	// first-run state and the caller starts from an empty one.
	if (!object) return jsonError('not found', 404)
	return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream' } })
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
			if (pathname.startsWith('/upload/')) {
				return withCors(await handleFetchOwn(request, env, decodeURIComponent(pathname.slice(8))))
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

		if (method === 'DELETE' && pathname.startsWith('/upload/')) {
			return withCors(await handleDelete(request, env, decodeURIComponent(pathname.slice(8))))
		}

		return jsonError('not found', 404)
	},
}
