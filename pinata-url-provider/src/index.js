/**
 * pinata-url-provider — a self-contained Cloudflare Worker.
 *
 * Flow:
 *   1. The caller proves control of an address by signing a one-time challenge
 *      (EIP-191 `personal_sign`). If the signature doesn't verify, the request is
 *      rejected with "Verification failed…" — see `verifyCallerOwnsAddress()`.
 *   2. The worker calls `isRegistered(address)` on the Fangorn registry contract
 *      (a Stylus contract on Arbitrum Sepolia; address + RPC are configurable) to
 *      check whether that public key is registered. If not, the caller is told to
 *      register at fangorn.network. This can be stubbed for local dev with
 *      STUB_REGISTRATION_CHECK="true".
 *   3. If registered, the worker mints a short-lived Pinata *presigned upload URL*
 *      and returns it, so the caller can pin one file to IPFS without ever seeing
 *      your Pinata JWT.
 *
 * The only dependency is `viem` (signature recovery + selector encoding). All
 * behaviour is driven by environment variables (see wrangler.toml / README).
 */

import { recoverMessageAddress, toFunctionSelector } from 'viem';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'Method not allowed. Use GET or POST.' }, cors);
    }

    // Read the request once (the POST body can only be consumed a single time):
    // address plus the optional ownership proof (message + signature).
    const input = await readInput(request);
    const address = (input.address || '').toLowerCase();
    if (!isAddress(address)) {
      return json(400, { error: 'Provide a valid EVM address via ?address=0x… or JSON body { "address": "0x…" }.' }, cors);
    }

    // Prove the caller controls `address` via a signed challenge (always required).
    const ownership = await verifyCallerOwnsAddress(input, address, env);
    if (!ownership.ok) {
      return json(401, {
        ok: false,
        address,
        error: ownership.error,
        // Echo the exact message the caller must sign, so they can retry.
        challenge: ownership.challenge,
      }, cors);
    }

    // 1) Check on-chain registration — unless STUB_REGISTRATION_CHECK is set, in
    // which case a valid signature alone is enough (useful for local dev/testing
    // without an RPC endpoint).
    const stubbed = (env.STUB_REGISTRATION_CHECK ?? 'false') === 'true';
    if (!stubbed) {
      let registered;
      try {
        registered = await isRegistered(env, address);
      } catch (err) {
        return json(502, { error: 'On-chain registration check failed.', detail: String(err?.message || err) }, cors);
      }
      if (!registered) {
        const registerUrl = env.REGISTER_URL || 'https://fangorn.network';
        return json(403, {
          ok: false,
          address,
          error: `This public key is not registered. Please login on ${registerUrl} to register.`,
        }, cors);
      }
    }

    // Resolve the upload size the caller declared (the SDK sends its exact byte
    // length). Absent → a back-compat default. Bounded per-request so nobody can
    // mint a URL for an absurd file.
    const maxUpload = Number(env.MAX_UPLOAD_SIZE || DEFAULT_MAX_UPLOAD);
    let size;
    if (input.size == null || input.size === '') {
      size = Number(env.DEFAULT_UPLOAD_SIZE || DEFAULT_UPLOAD_SIZE);
    } else {
      size = Number(input.size);
      if (!Number.isInteger(size) || size <= 0) {
        return json(400, { error: 'size must be a positive integer number of bytes.' }, cors);
      }
    }
    if (size > maxUpload) {
      return json(413, {
        ok: false,
        address,
        error: `Requested upload size ${size} exceeds the per-upload maximum of ${maxUpload} bytes.`,
      }, cors);
    }

    // Per-wallet daily *byte budget* — bounds the Pinata bill now that callers
    // declare their size. Checked after auth so an over-budget wallet never
    // mints; usage is recorded only on a successful grant (a failed mint costs
    // no quota). Debits the declared size, which the SDK sets to the exact bytes.
    //
    // Retries reuse the caller's uploadId: a transient upload failure re-mints a
    // fresh (single-use) URL, but must NOT re-charge. A size already paid under
    // this uploadId skips both the budget check and the debit.
    const cap = byteCapConfig(env);
    let used = 0;
    let charge = cap.active;
    if (cap.active && input.uploadId) {
      const paid = await paidSize(env, address, input.uploadId);
      if (paid !== null && size <= paid) charge = false; // already paid on a prior attempt
    }
    if (charge) {
      used = await currentUsage(env, address);
      if (used + size > cap.limit) {
        return json(429, {
          ok: false,
          address,
          error: `Daily storage budget reached (${cap.limit} bytes/wallet, ${used} used). Resets at 00:00 UTC.`,
        }, cors);
      }
    }

    // 2) Registered (or stubbed) — issue a Pinata presigned upload URL scoped to
    // the requested size (plus a little multipart/form-data headroom).
    try {
      const maxFileSize = size + UPLOAD_HEADROOM;
      const uploadUrl = await createPinataUploadUrl(env, maxFileSize);
      if (charge) {
        await recordUsage(env, address, used, size);
        if (input.uploadId) await markPaid(env, address, input.uploadId, size);
      }
      return json(200, {
        ok: true,
        address,
        uploadUrl,
        network: env.PINATA_NETWORK || 'public',
        maxFileSize,
        expiresIn: Number(env.PINATA_URL_EXPIRES || 300),
        ...(stubbed ? { stubbed: true } : {}),
      }, cors);
    } catch (err) {
      return json(502, { error: 'Failed to create Pinata upload URL.', detail: String(err?.message || err) }, cors);
    }
  },
};

/* ─────────────────────────── registration check ────────────────────────── */

// Default RPC endpoint (the public Arbitrum Sepolia RPC is fine for a read-only
// eth_call). The registry *contract* deliberately has NO default: gating on the
// wrong contract silently is worse than failing, so it must be set explicitly in
// wrangler.toml (a `[build]` guard there also blocks deploy if it's absent).
const DEFAULT_RPC_URL = 'https://sepolia-rollup.arbitrum.io/rpc';

// The registry's ABI function. NOTE: the Stylus (Rust) contract's `is_registered`
// method is exposed in the ABI as camelCase `isRegistered(address)` — calling the
// snake_case selector reverts. Verified on-chain against the default contract.
const DEFAULT_REGISTRY_FUNCTION = 'isRegistered(address)';

/**
 * Returns whether `address` is registered, by calling the registry's
 * `isRegistered(address)` view (returns `bool`).
 *
 * Env:
 *   RPC_URL                    EVM JSON-RPC endpoint (optional; defaults to the
 *                              public Arbitrum Sepolia RPC).
 *   REGISTRY_CONTRACT_ADDRESS  Registry contract to call — REQUIRED, no default.
 *   REGISTRY_FUNCTION          ABI signature of the check (optional; default
 *                              "isRegistered(address)").
 */
async function isRegistered(env, address) {
  const rpcUrl = env.RPC_URL || DEFAULT_RPC_URL;
  const contract = env.REGISTRY_CONTRACT_ADDRESS;
  if (!isAddress(contract)) throw new Error('REGISTRY_CONTRACT_ADDRESS is not set (or not a valid address) in wrangler.toml.');

  const selector = toFunctionSelector(env.REGISTRY_FUNCTION || DEFAULT_REGISTRY_FUNCTION);
  const data = selector + encodeAddress(address);

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: contract, data }, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message || JSON.stringify(body.error)}`);

  // `isRegistered` returns a bool — the ABI word is 1 (true) or 0 (false).
  return firstWord(body.result) !== 0n;
}

/* ─────────────────────────── per-wallet rate cap ───────────────────────── */

// Upload sizing defaults (all overridable via env; bytes).
const DEFAULT_UPLOAD_SIZE = 10 * 1024 * 1024;   // used when a caller omits `size` (older SDKs)
const DEFAULT_MAX_UPLOAD = 500 * 1024 * 1024;   // per-request ceiling when MAX_UPLOAD_SIZE unset
const UPLOAD_HEADROOM = 4096;                    // multipart/form-data overhead slack on max_file_size

// Per-wallet daily *byte budget*, backed by Workers KV. The SDK declares each
// upload's size, so we meter the bytes we grant per wallet per UTC day — a
// direct bound on the Pinata bill. Inactive unless DAILY_BYTE_LIMIT > 0 and the
// RATE_KV namespace is bound, so existing deployments/tests are unaffected until
// opted in.
// ponytail: KV is eventually consistent, so a concurrent burst across edge
// locations can overshoot the budget by a little. Fine for a cost guard; swap to
// a Durable Object if you ever need exact enforcement.
function byteCapConfig(env) {
  const limit = Number(env.DAILY_BYTE_LIMIT || 0);
  return { active: limit > 0 && !!env.RATE_KV, limit };
}

// One byte counter per wallet per UTC day.
function usageKey(address) {
  return `bytes:${address}:${new Date().toISOString().slice(0, 10)}`;
}

async function currentUsage(env, address) {
  return Number(await env.RATE_KV.get(usageKey(address))) || 0;
}

async function recordUsage(env, address, used, size) {
  // TTL only needs to outlive the UTC day the key belongs to; 2 days is plenty.
  await env.RATE_KV.put(usageKey(address), String(used + size), { expirationTtl: 172800 });
}

// Idempotency marker so retries of one logical upload (same uploadId) are
// charged once. Stores the paid size; a re-mint at the same-or-smaller size is
// free (the legit retry case), a larger size is charged normally.
// ponytail: a modified client could reuse an uploadId for other same-size files
// within the TTL to under-pay — acceptable for a soft budget already bypassable
// via multiple wallets. Make uploadId a content hash to close it (that also
// dedupes identical content, which Pinata pins once anyway).
function paidKey(address, uploadId) {
  return `paid:${address}:${uploadId}`;
}

async function paidSize(env, address, uploadId) {
  const raw = await env.RATE_KV.get(paidKey(address, uploadId));
  return raw === null ? null : Number(raw) || 0;
}

async function markPaid(env, address, uploadId, size) {
  // Only needs to outlive the retry window (~2 min at 6 attempts); keep it short.
  await env.RATE_KV.put(paidKey(address, uploadId), String(size), { expirationTtl: 3600 });
}

/* ───────────────────────────── pinata ──────────────────────────────────── */

/**
 * Mints a Pinata presigned upload URL. The caller can then upload one file with:
 *   const fd = new FormData();
 *   fd.append('file', file);
 *   fd.append('network', '<network>');
 *   await fetch(uploadUrl, { method: 'POST', body: fd });
 *
 * Docs: https://docs.pinata.cloud/files/presigned-urls
 */
async function createPinataUploadUrl(env, maxFileSize) {
  if (!env.PINATA_JWT) throw new Error('PINATA_JWT is not set.');

  const payload = {
    network: env.PINATA_NETWORK || 'public',
    expires: Number(env.PINATA_URL_EXPIRES || 300),
    date: Math.floor(Date.now() / 1000),
    max_file_size: maxFileSize,
  };
  if (env.PINATA_ALLOW_MIME_TYPES) {
    payload.allow_mime_types = env.PINATA_ALLOW_MIME_TYPES.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const res = await fetch('https://uploads.pinata.cloud/v3/files/sign', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.PINATA_JWT}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Pinata HTTP ${res.status}: ${data ? JSON.stringify(data) : '(no body)'}`);

  const url = data?.data || data?.url;
  if (!url) throw new Error(`Pinata returned no signed URL: ${JSON.stringify(data)}`);
  return url;
}

/* ───────────────────────────── helpers ─────────────────────────────────── */

/**
 * Prove the caller controls `address` by verifying a signed challenge.
 *
 * The caller signs the exact message from `buildChallengeMessage(address, now)`
 * with the private key behind `address` (EIP-191 `personal_sign`) and sends the
 * `message` + `signature` alongside it. We:
 *   1. parse the address + Issued-At back out of the message,
 *   2. require the message to be the canonical template verbatim (no tampering),
 *   3. require Issued-At to be fresh (within SIGNATURE_MAX_AGE) to bound replay,
 *   4. recover the signer from the signature and require it to equal `address`.
 *
 * Returns one of:
 *   { ok: true }
 *   { ok: false, needsSignature: true, error, challenge } — no proof supplied
 *     yet; `error`/`challenge` prompt the caller to sign and resend.
 *   { ok: false, error, challenge } — a signature was supplied but did not
 *     verify (wrong key, tampering, or a stale challenge).
 *
 * This is always enforced: the whole point is to bind the registration check to
 * a caller who provably controls the address, so there is no unauthenticated
 * mode.
 *
 * Env:
 *   SIGNATURE_MAX_AGE   How many seconds old an Issued-At may be (default 300).
 */
async function verifyCallerOwnsAddress(input, address, env) {
  const now = Math.floor(Date.now() / 1000);
  const challenge = buildChallengeMessage(address, now);

  const { message, signature } = input;
  // Handshake step 1 — nothing signed yet. Hand back the challenge to sign;
  // this is a prompt, not a failure.
  if (!message || !signature) {
    return {
      ok: false,
      needsSignature: true,
      error: 'Sign the `challenge` message below with your private key and resend it as { address, message, signature }.',
      challenge,
    };
  }

  // A signature was supplied but does not check out. Every failure path below
  // means the caller could not prove control of `address` — almost always
  // because they signed with the wrong key — so they all report the same thing.
  const fail = () => ({
    ok: false,
    error: 'Verification failed. Please be sure you have the correct private key.',
    challenge,
  });

  const parsed = parseChallengeMessage(message);
  if (!parsed) return fail();
  if (parsed.address.toLowerCase() !== address) return fail();

  // Reject anything that is not the canonical template verbatim.
  if (message !== buildChallengeMessage(parsed.address, parsed.issuedAt)) return fail();

  // Freshness: bound replay without server-side state. Allow small clock skew.
  const maxAge = Number(env.SIGNATURE_MAX_AGE || 300);
  const skew = 60;
  if (!(parsed.issuedAt <= now + skew && parsed.issuedAt >= now - maxAge)) return fail();

  // Recover the signer (EIP-191 personal_sign) and require it to equal `address`.
  let recovered;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    return fail();
  }
  if (recovered.toLowerCase() !== address) return fail();

  return { ok: true };
}

/**
 * The exact human-readable message a caller must sign to prove address control.
 * `issuedAt` is unix seconds; freshness is enforced against it above.
 */
function buildChallengeMessage(address, issuedAt) {
  return [
    'Fangorn onchain-gate access request',
    '',
    'I am proving that I control the wallet address below so the gate can issue',
    'me a one-time upload URL. This signature authorizes nothing else.',
    '',
    `Address: ${address}`,
    `Issued-At: ${issuedAt}`,
  ].join('\n');
}

/** Parse a challenge message back into { address, issuedAt }, or null. */
function parseChallengeMessage(message) {
  if (typeof message !== 'string') return null;
  const addr = message.match(/^Address: (0x[0-9a-fA-F]{40})$/m);
  const issued = message.match(/^Issued-At: (\d{1,20})$/m);
  if (!addr || !issued) return null;
  return { address: addr[1], issuedAt: Number(issued[1]) };
}

/** Collect { address, message, signature } from the query and/or a JSON body. */
async function readInput(request) {
  const q = new URL(request.url).searchParams;
  const out = {
    address: q.get('address')?.trim() || '',
    message: q.get('message') ?? undefined,          // signed verbatim — never trim
    signature: q.get('signature')?.trim() || undefined,
    size: q.get('size')?.trim() || undefined,        // declared upload size, bytes
    uploadId: q.get('uploadId')?.trim() || undefined, // idempotency key across retries
  };
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (body && typeof body === 'object') {
      if (!out.address && typeof body.address === 'string') out.address = body.address.trim();
      if (out.message == null && typeof body.message === 'string') out.message = body.message;
      if (!out.signature && typeof body.signature === 'string') out.signature = body.signature.trim();
      if (out.size == null && (typeof body.size === 'number' || typeof body.size === 'string')) {
        out.size = String(body.size);
      }
      if (!out.uploadId && typeof body.uploadId === 'string') out.uploadId = body.uploadId.trim();
    }
  }
  return out;
}

function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Left-pads a 20-byte address to a 32-byte ABI word (hex, no 0x prefix). */
function encodeAddress(address) {
  return address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** Reads the first 32-byte word of an eth_call result as a bigint. */
function firstWord(result) {
  if (!result || result === '0x') return 0n;
  const hex = result.slice(2, 66).padStart(64, '0');
  return BigInt('0x' + hex);
}

/**
 * Build CORS response headers.
 *
 * CORS is a *browser* mechanism: it only governs whether page JavaScript from a
 * given origin may read this response. It is NOT an access-control boundary and
 * it does not gate non-browser callers — curl, CLIs, servers and other scripts
 * neither send an enforceable `Origin` nor honour these headers, so they are
 * unaffected by ALLOWED_ORIGIN. The real gate is the signed-challenge ownership
 * proof (see verifyCallerOwnsAddress), which every caller goes through equally.
 *
 * ALLOWED_ORIGIN modes:
 *   "*" (default) — allow any browser origin.
 *   a comma-separated allowlist (e.g. "https://fangorn.network,https://app.x") —
 *     reflect the caller's Origin when it matches; add `Vary: Origin` so caches
 *     don't serve the wrong header. Browser requests from other origins are
 *     blocked by the browser; CLI callers still work regardless.
 */
function corsHeaders(env, request) {
  const base = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  };

  const allowed = (env.ALLOWED_ORIGIN || '*').trim();
  if (allowed === '*') {
    return { ...base, 'access-control-allow-origin': '*' };
  }

  const allowlist = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  const requestOrigin = request.headers.get('Origin');
  const headers = { ...base, vary: 'Origin' };
  if (requestOrigin && allowlist.includes(requestOrigin)) {
    headers['access-control-allow-origin'] = requestOrigin;
  }
  return headers;
}

function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders || {}) },
  });
}
