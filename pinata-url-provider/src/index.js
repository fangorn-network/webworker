/**
 * pinata-url-provider — a self-contained Cloudflare Worker.
 *
 * Flow:
 *   1. The caller proves control of an address by signing a one-time challenge
 *      (EIP-191 `personal_sign`) — see `verifyCallerOwnsAddress()`.
 *   2. The address must not be denied (`deny:<address>` in RATE_KV), and the upload
 *      must fit the address's daily byte quota and the worker's global one.
 *   3. The worker mints a short-lived Pinata *presigned upload URL* and returns it,
 *      so the caller can pin one file to IPFS without ever seeing the Pinata JWT.
 *
 * Everything else is driven by environment variables (see wrangler.toml / README).
 */

import { recoverMessageAddress } from 'viem';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'Method not allowed. Use GET or POST.' }, cors);
    }

    // GET /usage?address=0x… — a publisher's byte counter for today and the limits.
    // Read-only and unauthenticated: byte counts aren't sensitive.
    const url = new URL(request.url);
    if (url.pathname === '/usage') {
      const who = (url.searchParams.get('address') || '').toLowerCase();
      if (!isAddress(who)) {
        return json(400, { error: 'Provide a valid address via ?address=0x….' }, cors);
      }
      const cap = byteCapConfig(env);
      return json(200, {
        ok: true,
        address: who,
        daily: env.RATE_KV ? await currentUsage(env, who) : 0,
        dailyLimit: cap.active ? cap.limit : 0,
        day: new Date().toISOString().slice(0, 10),
      }, cors);
    }

    // Read the request once (the POST body can only be consumed a single time).
    const input = await readInput(request);
    const address = (input.address || '').toLowerCase();
    if (!isAddress(address)) {
      return json(400, { error: 'Provide a valid EVM address via ?address=0x… or JSON body { "address": "0x…" }.' }, cors);
    }

    const ownership = await verifyCallerOwnsAddress(input, address, env);
    if (!ownership.ok) {
      return json(401, { ok: false, address, error: ownership.error, challenge: ownership.challenge }, cors);
    }

    if (env.RATE_KV && (await env.RATE_KV.get(denyKey(address))) !== null) {
      return json(403, { ok: false, address, error: 'This address may not upload through this worker.' }, cors);
    }

    // Resolve the declared upload size (the SDK sends its exact byte length).
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

    // Daily byte quotas: one per publisher, and one for the whole worker, which
    // bounds the Pinata bill however many wallets ask. Usage is recorded only on a
    // successful grant. A retry under the same uploadId re-mints without
    // re-charging.
    const cap = byteCapConfig(env);
    const total = globalCapConfig(env);
    let charge = (cap.active || total.active) && !!env.RATE_KV;
    if (charge && input.uploadId) {
      const paid = await paidSize(env, address, input.uploadId);
      if (paid !== null && size <= paid) charge = false;
    }
    let used = 0;
    let usedAll = 0;
    if (charge) {
      [used, usedAll] = await Promise.all([currentUsage(env, address), currentUsage(env, ALL)]);
      if (cap.active && used + size > cap.limit) {
        return json(429, {
          ok: false,
          address,
          error: `Daily storage quota reached for ${address} (${cap.limit} bytes/day, ${used} used). Resets at 00:00 UTC.`,
        }, cors);
      }
      if (total.active && usedAll + size > total.limit) {
        return json(429, {
          ok: false,
          address,
          error: 'This worker has reached its storage budget for today. Resets at 00:00 UTC.',
        }, cors);
      }
    }

    try {
      const maxFileSize = size + UPLOAD_HEADROOM;
      const uploadUrl = await createPinataUploadUrl(env, maxFileSize, address);
      if (charge) {
        await Promise.all([recordUsage(env, address, used, size), recordUsage(env, ALL, usedAll, size)]);
        if (input.uploadId) await markPaid(env, address, input.uploadId, size);
      }
      return json(200, {
        ok: true,
        address,
        uploadUrl,
        network: env.PINATA_NETWORK || 'public',
        maxFileSize,
        expiresIn: Number(env.PINATA_URL_EXPIRES || 300),
      }, cors);
    } catch (err) {
      return json(502, { error: 'Failed to create Pinata upload URL.', detail: String(err?.message || err) }, cors);
    }
  },
};

/* ───────────────────────────── quotas ──────────────────────────────────── */

// Upload sizing defaults (all overridable via env; bytes).
const DEFAULT_UPLOAD_SIZE = 10 * 1024 * 1024;   // used when a caller omits `size` (older SDKs)
const DEFAULT_MAX_UPLOAD = 500 * 1024 * 1024;   // per-request ceiling when MAX_UPLOAD_SIZE unset
const UPLOAD_HEADROOM = 4096;                    // multipart/form-data overhead slack on max_file_size

// Daily byte quotas, backed by Workers KV: DAILY_BYTE_LIMIT per publisher, and
// GLOBAL_DAILY_BYTE_LIMIT for everyone together. Each is off at 0 or unset, or
// without the RATE_KV binding.
// ponytail: KV is eventually consistent and allows one write per second per key,
// so a concurrent burst can overshoot a quota a little or drop a debit. Fine for
// a cost guard; a Durable Object if it ever needs to be exact.
function byteCapConfig(env) {
  const limit = Number(env.DAILY_BYTE_LIMIT || 0);
  return { active: limit > 0 && !!env.RATE_KV, limit };
}

function globalCapConfig(env) {
  const limit = Number(env.GLOBAL_DAILY_BYTE_LIMIT || 0);
  return { active: limit > 0 && !!env.RATE_KV, limit };
}

/** The global counter's key in place of an address. */
const ALL = 'all';

/** Set (to anything) by the operator to refuse an address: `wrangler kv key put deny:0x… 1`. */
function denyKey(address) {
  return `deny:${address}`;
}

// One byte counter per publisher (or ALL) per UTC day.
function usageKey(who) {
  return `bytes:${who}:${new Date().toISOString().slice(0, 10)}`;
}

async function currentUsage(env, who) {
  return Number(await env.RATE_KV.get(usageKey(who))) || 0;
}

async function recordUsage(env, who, used, size) {
  // TTL only needs to outlive the UTC day the key belongs to; 2 days is plenty.
  await env.RATE_KV.put(usageKey(who), String(used + size), { expirationTtl: 172800 });
}

// Idempotency marker so retries of one logical upload (same uploadId) are
// charged once. Stores the paid size; a re-mint at the same-or-smaller size is
// free (the legit retry case), a larger size is charged normally.
// ponytail: a modified client could reuse an uploadId for other same-size files
// within the TTL to under-count — acceptable for a soft budget. Make uploadId a
// content hash to close it (that also dedupes identical content, which Pinata
// pins once anyway).
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

const PINATA_API = 'https://api.pinata.cloud/v3';

/**
 * The Pinata group every one of `address`'s uploads is filed under, created on
 * first use. Groups are how a whole deployment's pins stay sweepable: a cleanup
 * job lists groups by name prefix and unpins their files, without needing any
 * record of what was uploaded.
 *
 * Name is `${PINATA_GROUP_PREFIX}:${address}` — per wallet, namespaced by
 * deployment, so a publisher's pins sweep as a unit. The prefix is REQUIRED: a pin filed under no
 * group (or under an unlabelled one) is a pin no cleanup job can find, which
 * defeats the point, so an unset prefix fails the request rather than minting.
 *
 * Resolution order: KV cache → look up by name → create. The by-name lookup is
 * what stops a lost KV entry from forking one wallet's pins across two groups.
 *
 * ponytail: two concurrent first-uploads from one wallet can both miss and
 * create a duplicate same-named group. Harmless — the sweep matches on name, so
 * both get caught — and self-heals once one wins the cache. A Durable Object
 * would serialize it, same trade-off as the KV byte counters above.
 */
async function walletGroupId(env, address) {
  const prefix = (env.PINATA_GROUP_PREFIX || '').trim();
  if (!prefix) throw new Error('PINATA_GROUP_PREFIX is not set (every upload must be filed under a group).');
  const name = `${prefix}:${address}`;
  const key = `group:${name}`;

  // Lifetime cache (no TTL) — a wallet's group never changes.
  if (env.RATE_KV) {
    const cached = await env.RATE_KV.get(key);
    if (cached) return cached;
  }

  const auth = { authorization: `Bearer ${env.PINATA_JWT}` };
  // Groups are per-network, same as the files they hold.
  const groups = `${PINATA_API}/groups/${env.PINATA_NETWORK || 'public'}`;
  // `name` filters by substring, so match exactly rather than taking groups[0].
  const found = await pinataJson(`${groups}?name=${encodeURIComponent(name)}`, { headers: auth });
  let id = found?.groups?.find((g) => g.name === name)?.id;

  if (!id) {
    const created = await pinataJson(groups, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    id = created?.data?.id;
    if (!id) throw new Error(`Pinata returned no group id: ${JSON.stringify(created)}`);
  }

  if (env.RATE_KV) await env.RATE_KV.put(key, id);
  return id;
}

/** fetch + JSON against the Pinata API, throwing with the body on a non-2xx. */
async function pinataJson(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Pinata HTTP ${res.status}: ${data ? JSON.stringify(data) : '(no body)'}`);
  return data;
}

/**
 * Mints a Pinata presigned upload URL. The caller can then upload one file with:
 *   const fd = new FormData();
 *   fd.append('file', file);
 *   fd.append('network', '<network>');
 *   await fetch(uploadUrl, { method: 'POST', body: fd });
 *
 * `group_id` is signed into the URL, so the uploader cannot file the pin
 * somewhere else (or nowhere).
 *
 * Docs: https://docs.pinata.cloud/files/presigned-urls
 */
async function createPinataUploadUrl(env, maxFileSize, address) {
  if (!env.PINATA_JWT) throw new Error('PINATA_JWT is not set.');

  const payload = {
    network: env.PINATA_NETWORK || 'public',
    expires: Number(env.PINATA_URL_EXPIRES || 300),
    date: Math.floor(Date.now() / 1000),
    max_file_size: maxFileSize,
    group_id: await walletGroupId(env, address),
  };
  if (env.PINATA_ALLOW_MIME_TYPES) {
    payload.allow_mime_types = env.PINATA_ALLOW_MIME_TYPES.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const data = await pinataJson('https://uploads.pinata.cloud/v3/files/sign', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.PINATA_JWT}`,
    },
    body: JSON.stringify(payload),
  });

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
 * Always enforced: quotas are per address, so the caller must control it.
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
    'Fangorn upload request',
    '',
    'I am proving that I control the wallet address below so the worker can issue',
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
