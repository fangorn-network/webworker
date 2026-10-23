/**
 * pinata-url-provider — a self-contained Cloudflare Worker.
 *
 * Flow:
 *   1. The caller names the app the upload is for (`appId`, required: an app is
 *      sponsored storage, and every byte is billed to one).
 *   2. The caller proves control of an address by signing a one-time challenge
 *      (EIP-191 `personal_sign`) that names the address AND the app, so a signature
 *      is good for that app only. If it doesn't verify, the request is rejected with
 *      "Verification failed…" — see `verifyCallerOwnsAddress()`.
 *   3. One read decides: `access(appId, address)` on the AppRegistry on Base Sepolia
 *      (address from the Fangorn SDK's BaseSepoliaConfig). Its `canPublish` holds
 *      while the app is claimed, not taken down and paid up, the wallet is not
 *      banned network-wide, and the app's owner has accepted the wallet and not
 *      suspended it. A refusal is explained with a few more reads, on that path only.
 *   4. If it holds, the worker mints a short-lived Pinata *presigned upload URL* and
 *      returns it, so the caller can pin one file to IPFS without ever seeing your
 *      Pinata JWT.
 *
 * Dependencies are `viem` (signature recovery + selector encoding) and the Fangorn
 * SDK, which supplies the deployment addresses. Everything else is driven by
 * environment variables (see wrangler.toml / README).
 */

import { recoverMessageAddress, toFunctionSelector } from 'viem';
// Deep import on purpose: `lib/config.js` pulls in nothing but viem, while the SDK's
// package root reaches the harness (node `fs`/`path`) and the graph engine — none of
// which a workerd bundle can or should carry.
import { BaseSepoliaConfig } from '@fangorn-network/sdk/lib/config.js';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'Method not allowed. Use GET or POST.' }, cors);
    }

    // GET /usage?appId=0x… — an app's byte counter for today and the configured
    // limit, so the dashboard can show usage. Read-only and unauthenticated: byte
    // counts aren't sensitive (and are roughly inferable on-chain), while the
    // sensitive action — minting an upload URL — still requires the signed
    // ownership proof below.
    const url = new URL(request.url);
    if (url.pathname === '/usage') {
      const usageApp = (url.searchParams.get('appId') || '').toLowerCase();
      if (!isBytes32(usageApp)) {
        return json(400, { error: 'Provide a valid app id via ?appId=0x… (0x + 64 hex chars).' }, cors);
      }
      const cap = byteCapConfig(env);
      return json(200, {
        ok: true,
        appId: usageApp,
        daily: env.RATE_KV ? await currentUsage(env, usageApp) : 0,
        dailyLimit: cap.active ? cap.limit : 0,
        day: new Date().toISOString().slice(0, 10),
      }, cors);
    }

    // Read the request once (the POST body can only be consumed a single time):
    // address plus the optional ownership proof (message + signature).
    const input = await readInput(request);
    const address = (input.address || '').toLowerCase();
    if (!isAddress(address)) {
      return json(400, { error: 'Provide a valid EVM address via ?address=0x… or JSON body { "address": "0x…" }.' }, cors);
    }

    // The app this upload is billed to. Required: there is no default app, and no
    // storage outside an app.
    if (!input.appId) {
      return json(400, { error: 'Provide the app this upload is for via appId (0x + 64 hex chars).' }, cors);
    }
    const appId = input.appId.toLowerCase();
    if (!isBytes32(appId)) {
      return json(400, { error: 'appId must be a 32-byte hex string (0x + 64 hex chars).' }, cors);
    }

    // Prove the caller controls `address` via a signed challenge (always required).
    const ownership = await verifyCallerOwnsAddress(input, address, appId, env);
    if (!ownership.ok) {
      return json(401, {
        ok: false,
        address,
        error: ownership.error,
        // Echo the exact message the caller must sign, so they can retry.
        challenge: ownership.challenge,
      }, cors);
    }

    // 1) On-chain gate — one read when it passes: `access(appId, caller)`. Its
    // `canPublish` is the AppRegistry's single rule for who an app provides
    // storage to, so the worker adds no rules of its own.
    try {
      const access = await readAccess(env, appId, address);
      if (!access.canPublish) {
        const denial = await denialReason(env, appId, address, access);
        return json(denial.status, { ok: false, address, error: denial.error }, cors);
      }
    } catch (err) {
      return json(502, { error: 'An error occurred when checking Onchain access conditions.', detail: String(err?.message || err) }, cors);
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

    // Per-app daily *byte budget* — bounds the Pinata bill. One budget covers all
    // of an app's publishers, since the app is what pays. Checked after auth so
    // an over-budget app never mints; usage is recorded only on a successful
    // grant (a failed mint costs no quota). Debits the declared size, which the
    // SDK sets to the exact bytes.
    //
    // Retries reuse the caller's uploadId: a transient upload failure re-mints a
    // fresh (single-use) URL, but must NOT re-charge. A size already paid under
    // this uploadId skips both the budget check and the debit.
    const cap = byteCapConfig(env);
    let used = 0;
    let charge = cap.active;
    if (charge && input.uploadId) {
      const paid = await paidSize(env, appId, input.uploadId);
      if (paid !== null && size <= paid) charge = false; // already granted on a prior attempt
    }
    if (charge) {
      used = await currentUsage(env, appId);
      if (used + size > cap.limit) {
        return json(429, {
          ok: false,
          address,
          error: `Daily storage budget reached for app ${appId} (${cap.limit} bytes/app, ${used} used). Resets at 00:00 UTC.`,
        }, cors);
      }
    }

    // 2) Granted — issue a Pinata presigned upload URL scoped to the requested
    // size (plus a little multipart/form-data headroom).
    try {
      const maxFileSize = size + UPLOAD_HEADROOM;
      const uploadUrl = await createPinataUploadUrl(env, maxFileSize, address, appId);
      if (charge) {
        await recordUsage(env, appId, used, size);
        if (input.uploadId) await markPaid(env, appId, input.uploadId, size);
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

/* ───────────────────────── on-chain access gate ────────────────────────── */

// The deployment is Base Sepolia's, from the SDK, which is the only thing that
// knows which contracts belong together. The address is not configurable: an SDK
// version bump is the repoint.
const DEFAULT_RPC_URL = BaseSepoliaConfig.rpcUrl;
const SDK_APP_REGISTRY_ADDRESS = BaseSepoliaConfig.appRegistryContractAddress;

// The AppRegistry view `access(bytes32 appId, address) -> (bool canPublish,
// address owner, uint64 expiresAt)`: whether the app provides this wallet storage
// now, who owns the app, and when its subscription expires (0 once cancelled).
const ACCESS_FUNCTION = 'access(bytes32,address)';
// Read only to explain a denial — see denialReason().
const APP_SUSPENDED_FUNCTION = 'isAppSuspended(bytes32)';
const GLOBAL_SUSPENSION_FUNCTION = 'globalSuspensions(address)';
const APP_STATUS_FUNCTION = 'statusForApp(bytes32,address)';
// AppRegistry.Status: 0 None (never accepted), 1 Active, 2 Suspended, 3 Invited
// (retired, from the old join flow; not a member).
const STATUS_SUSPENDED = 2n;
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

/** A registry address from the SDK, or a loud failure — never a silent fallback. */
function sdkAddress(address, name) {
  if (!isAddress(address || '')) {
    throw new Error(
      `The Fangorn SDK supplied no valid ${name} ("${address}"); `
      + 'upgrade @fangorn-network/sdk to one that carries it.');
  }
  return address;
}

/** One `eth_call`: ABI signature + already-encoded 32-byte argument words → raw hex. */
async function ethCall(env, to, signature, words) {
  const rpcUrl = env.RPC_URL || DEFAULT_RPC_URL;
  const data = toFunctionSelector(signature) + words.join('');

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

/**
 * One `eth_call` to the AppRegistry's `access(appId, address)` view, returning
 * `{ canPublish, owner, expiresAt }`. `owner` is the zero address for an unclaimed
 * app; `expiresAt` is when its subscription expires (Unix seconds bigint, 0 once
 * cancelled). The contract applies the expiry itself, so `canPublish` already
 * covers it.
 *
 * Env:
 *   RPC_URL   EVM JSON-RPC endpoint (optional; defaults to the SDK's public Base
 *             Sepolia RPC).
 */
async function readAccess(env, appId, address) {
  const result = await ethCall(
    env, sdkAddress(SDK_APP_REGISTRY_ADDRESS, 'appRegistryContractAddress'),
    ACCESS_FUNCTION, [encodeBytes32(appId), encodeAddress(address)]);
  // Three 32-byte words: [0] bool canPublish, [1] address owner, [2] uint64 expiresAt.
  return { canPublish: wordAt(result, 0) !== 0n, owner: addressAt(result, 1), expiresAt: wordAt(result, 2) };
}

/**
 * Why `access` refused the caller, as `{ status, error }`. `canPublish` folds
 * several causes into one, and the right advice differs for each: the first two
 * come from `access` itself, the rest from three more reads. Failure path only —
 * a granted upload makes none of them.
 */
async function denialReason(env, appId, address, access) {
  if (access.owner === ZERO_ADDRESS) {
    return { status: 403, error: `App ${appId} has not been claimed: it has no owner on-chain.` };
  }
  if (access.expiresAt <= BigInt(Math.floor(Date.now() / 1000))) {
    const subscribeUrl = env.SUBSCRIBE_URL || 'https://fangorn.network';
    return {
      status: 402,
      error: `The storage subscription for app ${appId} has expired. Its owner (${access.owner}) must renew it at ${subscribeUrl}`,
    };
  }
  const apps = sdkAddress(SDK_APP_REGISTRY_ADDRESS, 'appRegistryContractAddress');
  const id = encodeBytes32(appId);
  const wallet = encodeAddress(address);
  const [appSuspended, banned, status] = await Promise.all([
    ethCall(env, apps, APP_SUSPENDED_FUNCTION, [id]),
    ethCall(env, apps, GLOBAL_SUSPENSION_FUNCTION, [wallet]),
    ethCall(env, apps, APP_STATUS_FUNCTION, [id, wallet]),
  ]);
  if (wordAt(appSuspended, 0) !== 0n) return { status: 403, error: `App ${appId} has been taken down.` };
  if (wordAt(banned, 0) !== 0n) {
    return { status: 403, error: 'This public key has been suspended from publishing on Fangorn.' };
  }
  if (wordAt(status, 0) === STATUS_SUSPENDED) {
    return { status: 403, error: `This public key is suspended from app ${appId}.` };
  }
  if (wordAt(status, 0) !== 1n) {
    // None, or Invited from the old join flow: either way the owner has not accepted it.
    return { status: 403, error: `This public key has not been accepted by app ${appId}. Ask the app's owner to accept it.` };
  }
  // Every cause above reads clear, yet `access` refused: the chain's block time
  // passed the expiry before this worker's clock did, or the state changed between
  // the reads.
  return { status: 403, error: `This public key may not publish to app ${appId} right now.` };
}

/* ──────────────────────────── per-app rate cap ─────────────────────────── */

// Upload sizing defaults (all overridable via env; bytes).
const DEFAULT_UPLOAD_SIZE = 10 * 1024 * 1024;   // used when a caller omits `size` (older SDKs)
const DEFAULT_MAX_UPLOAD = 500 * 1024 * 1024;   // per-request ceiling when MAX_UPLOAD_SIZE unset
const UPLOAD_HEADROOM = 4096;                    // multipart/form-data overhead slack on max_file_size

// Per-app daily *byte budget*, backed by Workers KV. The SDK declares each
// upload's size, so we meter the bytes we grant per app per UTC day — a direct
// bound on the Pinata bill. Inactive unless DAILY_BYTE_LIMIT > 0 and the RATE_KV
// namespace is bound, so existing deployments/tests are unaffected until opted in.
// ponytail: KV is eventually consistent and allows one write per second per key,
// so a concurrent burst from an app's publishers can overshoot the budget a
// little or drop a debit. Fine for a cost guard; swap to a Durable Object if you
// ever need exact enforcement.
function byteCapConfig(env) {
  const limit = Number(env.DAILY_BYTE_LIMIT || 0);
  return { active: limit > 0 && !!env.RATE_KV, limit };
}

// One byte counter per app per UTC day.
function usageKey(appId) {
  return `bytes:${appId}:${new Date().toISOString().slice(0, 10)}`;
}

async function currentUsage(env, appId) {
  return Number(await env.RATE_KV.get(usageKey(appId))) || 0;
}

async function recordUsage(env, appId, used, size) {
  // TTL only needs to outlive the UTC day the key belongs to; 2 days is plenty.
  await env.RATE_KV.put(usageKey(appId), String(used + size), { expirationTtl: 172800 });
}

// Idempotency marker so retries of one logical upload (same uploadId) are
// charged once. Stores the paid size; a re-mint at the same-or-smaller size is
// free (the legit retry case), a larger size is charged normally.
// ponytail: a modified client could reuse an uploadId for other same-size files
// within the TTL to under-count — acceptable for a soft budget. Make uploadId a
// content hash to close it (that also dedupes identical content, which Pinata
// pins once anyway).
function paidKey(appId, uploadId) {
  return `paid:${appId}:${uploadId}`;
}

async function paidSize(env, appId, uploadId) {
  const raw = await env.RATE_KV.get(paidKey(appId, uploadId));
  return raw === null ? null : Number(raw) || 0;
}

async function markPaid(env, appId, uploadId, size) {
  // Only needs to outlive the retry window (~2 min at 6 attempts); keep it short.
  await env.RATE_KV.put(paidKey(appId, uploadId), String(size), { expirationTtl: 3600 });
}

/* ───────────────────────────── pinata ──────────────────────────────────── */

const PINATA_API = 'https://api.pinata.cloud/v3';

/**
 * The Pinata group every one of `address`'s uploads is filed under, created on
 * first use. Groups are how a whole deployment's pins stay sweepable: a cleanup
 * job lists groups by name prefix and unpins their files, without needing any
 * record of what was uploaded.
 *
 * Name is `${PINATA_GROUP_PREFIX}:${appId12}:${wallet12}` (see groupName) — per wallet,
 * namespaced by deployment and by app, so an app's pins sweep as a unit and stay
 * attributable to the publisher. The prefix is REQUIRED: a pin filed under no
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
async function walletGroupId(env, address, appId) {
  const prefix = (env.PINATA_GROUP_PREFIX || '').trim();
  if (!prefix) throw new Error('PINATA_GROUP_PREFIX is not set (every upload must be filed under a group).');
  const name = groupName(prefix, appId, address);
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
  let id = found?.data?.groups?.find((g) => g.name === name)?.id;

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

/**
 * A wallet's group name for an app. Pinata rejects group names over 50 characters with a 400 "malformed
 * request" (measured 2026-10-23: 50 accepted, 51 refused; its API docs state no limit, so this may move), so
 * the app and wallet go in as their first 12 hex digits: `testnet-base:` + 12 + `:`
 * + 12 is 38. 48 bits each: no two of a deployment's apps, or of an app's wallets, will share them in practice,
 * and an app's pins still sweep as a unit by the `${prefix}:${appId12}:` prefix. Both ids arrive validated and
 * lowercased.
 */
const GROUP_NAME_MAX = 50;
export function groupName(prefix, appId, address) {
  const short = (hex) => hex.replace(/^0x/, '').slice(0, 12);
  const name = `${prefix}:${short(appId)}:${short(address)}`;
  if (name.length > GROUP_NAME_MAX) {
    throw new Error(`PINATA_GROUP_PREFIX "${prefix}" is too long: Pinata caps group names at ${GROUP_NAME_MAX} characters, and this one is ${name.length}.`);
  }
  return name;
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
async function createPinataUploadUrl(env, maxFileSize, address, appId) {
  if (!env.PINATA_JWT) throw new Error('PINATA_JWT is not set.');

  const payload = {
    network: env.PINATA_NETWORK || 'public',
    expires: Number(env.PINATA_URL_EXPIRES || 300),
    date: Math.floor(Date.now() / 1000),
    max_file_size: maxFileSize,
    group_id: await walletGroupId(env, address, appId),
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
 * The caller signs the exact message from `buildChallengeMessage(address, appId,
 * now)` with the private key behind `address` (EIP-191 `personal_sign`) and sends
 * the `message` + `signature` alongside it. We:
 *   1. parse the address + Issued-At back out of the message,
 *   2. require the message to be the canonical template verbatim for this request's
 *      app (no tampering, and no reuse of a signature made for another app),
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
 * This is always enforced: the whole point is to bind the on-chain check to a
 * caller who provably controls the address, so there is no unauthenticated mode.
 *
 * Env:
 *   SIGNATURE_MAX_AGE   How many seconds old an Issued-At may be (default 300).
 */
async function verifyCallerOwnsAddress(input, address, appId, env) {
  const now = Math.floor(Date.now() / 1000);
  const challenge = buildChallengeMessage(address, appId, now);

  const { message, signature } = input;
  // Handshake step 1 — nothing signed yet. Hand back the challenge to sign;
  // this is a prompt, not a failure.
  if (!message || !signature) {
    return {
      ok: false,
      needsSignature: true,
      error: 'Sign the `challenge` message below with your private key and resend it as { address, appId, message, signature }.',
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

  // Reject anything that is not the canonical template verbatim, for this app.
  if (message !== buildChallengeMessage(parsed.address, appId, parsed.issuedAt)) return fail();

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
 * It names the app, so a signature only ever buys uploads for that app.
 * `issuedAt` is unix seconds; freshness is enforced against it above.
 */
function buildChallengeMessage(address, appId, issuedAt) {
  return [
    'Fangorn onchain-gate access request',
    '',
    'I am proving that I control the wallet address below so the gate can issue',
    'me a one-time upload URL for the app below. This signature authorizes nothing else.',
    '',
    `Address: ${address}`,
    `App: ${appId}`,
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
    appId: q.get('appId')?.trim() || undefined,      // the app this upload is billed to
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
      if (!out.appId && typeof body.appId === 'string') out.appId = body.appId.trim();
    }
  }
  return out;
}

function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

function isBytes32(v) {
  return /^0x[0-9a-fA-F]{64}$/.test(v);
}

/** A 32-byte hex value as a bare ABI word (hex, no 0x prefix). */
function encodeBytes32(value) {
  return value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** Left-pads a 20-byte address to a 32-byte ABI word (hex, no 0x prefix). */
function encodeAddress(address) {
  return address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** Reads the i-th 32-byte word of an eth_call result as a lowercase address. */
function addressAt(result, i) {
  return '0x' + wordAt(result, i).toString(16).padStart(40, '0');
}

/** Reads the i-th 32-byte word (0-indexed) of an eth_call result as a bigint. */
function wordAt(result, i) {
  if (!result || result === '0x') return 0n;
  const hex = result.slice(2 + i * 64, 2 + (i + 1) * 64);
  if (!hex) return 0n;
  return BigInt('0x' + hex.padStart(64, '0'));
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
