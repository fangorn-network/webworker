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
 * Dependencies are `viem` (signature recovery + selector encoding) and the Fangorn
 * SDK, which supplies the deployment addresses. Everything else is driven by
 * environment variables (see wrangler.toml / README).
 */

import { recoverMessageAddress, toFunctionSelector } from 'viem';
// Deep import on purpose: `lib/config.js` pulls in nothing but viem, while the SDK's
// package root reaches the harness (node `fs`/`path`) and the graph engine — none of
// which a workerd bundle can or should carry.
import { FangornConfig } from '@fangorn-network/sdk/lib/config.js';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'Method not allowed. Use GET or POST.' }, cors);
    }

    // GET /usage?address=0x… — a wallet's byte counters (lifetime total + today's
    // daily) and the configured limits, so the dashboard can show usage. Read-only
    // and unauthenticated: byte counts aren't sensitive (and are roughly inferable
    // on-chain), while the sensitive action — minting an upload URL — still requires
    // the signed ownership proof below.
    const url = new URL(request.url);
    if (url.pathname === '/usage') {
      const address = (url.searchParams.get('address') || '').toLowerCase();
      if (!isAddress(address)) {
        return json(400, { error: 'Provide a valid EVM address via ?address=0x….' }, cors);
      }
      const kvOn = !!env.RATE_KV;
      const free = freeTierConfig(env);
      const cap = byteCapConfig(env);
      return json(200, {
        ok: true,
        address,
        total: kvOn ? await currentTotal(env, address) : 0,
        freeLimit: free.active ? free.limit : 0,
        daily: kvOn ? await currentUsage(env, address) : 0,
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

    // 1) On-chain access gate — ONE call to the SubscriptionRegistry's access()
    // view returns both registration status (it cross-calls DataRegistry internally)
    // and the subscription timestamp. STUB_REGISTRATION_CHECK skips the chain
    // entirely (a valid signature alone suffices — dev/testing without an RPC).
    const stubbed = (env.STUB_REGISTRATION_CHECK ?? 'false') === 'true';
    let access = null;
    if (!stubbed) {
      try {
        access = await readAccess(env, address);
      } catch (err) {
        return json(502, { error: 'On-chain access check failed.', detail: String(err?.message || err) }, cors);
      }
      if (!access.registered) {
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
    const free = freeTierConfig(env);
    let used = 0;
    let total = 0;
    let charge = cap.active || free.active;
    if (charge && input.uploadId) {
      const paid = await paidSize(env, address, input.uploadId);
      if (paid !== null && size <= paid) charge = false; // already granted on a prior attempt
    }
    if (charge) {
      // Free tier: the first FREE_BYTE_LIMIT lifetime bytes are free. Beyond that,
      // the wallet must have an active on-chain subscription (fee paid within the
      // window). The upload that first crosses the limit already needs one.
      if (free.active) {
        total = await currentTotal(env, address);
        if (total + size > free.limit) {
          // Past the free tier: require an active subscription (fee paid within the
          // window). We already have paidAt from the access() read above. Stub mode
          // has no chain data → treat as active for dev.
          const active = stubbed || isWithinWindow(env, access.paidAt);
          if (!active) {
            const subscribeUrl = env.SUBSCRIBE_URL || 'https://fangorn.network/subscribe';
            return json(402, {
              ok: false,
              address,
              error: `To continue using Fangorn's storage, please sign up for a subscription at ${subscribeUrl}`,
            }, cors);
          }
        }
      }
      // Daily ceiling still applies to everyone (free and subscribed) as an abuse guard.
      if (cap.active) {
        used = await currentUsage(env, address);
        if (used + size > cap.limit) {
          return json(429, {
            ok: false,
            address,
            error: `Daily storage budget reached (${cap.limit} bytes/wallet, ${used} used). Resets at 00:00 UTC.`,
          }, cors);
        }
      }
    }

    // 2) Registered (or stubbed) — issue a Pinata presigned upload URL scoped to
    // the requested size (plus a little multipart/form-data headroom).
    try {
      const maxFileSize = size + UPLOAD_HEADROOM;
      const uploadUrl = await createPinataUploadUrl(env, maxFileSize, address);
      if (charge) {
        // Keep the lifetime counter climbing (even past the free limit) so a
        // wallet can't dip back under it after crossing and get free uploads again.
        if (free.active) await recordTotal(env, address, total, size);
        if (cap.active) await recordUsage(env, address, used, size);
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

/* ───────────────────────── on-chain access gate ────────────────────────── */

// The deployment comes from the SDK, which is the only thing that knows which
// contracts belong together. A SubscriptionRegistry is usable only if its
// `dataRegistry()` equals the registry the SDK publishes to — cross-calling
// `isRegistered` on a stale one makes `access()` return `registered: false` for every
// wallet, so uploads 403 network-wide with nothing in the logs to say why. Pinning
// the address here separately from the SDK is exactly how that pair drifts apart, so
// the version bump is the repoint: both move together or neither does.
const DEFAULT_RPC_URL = FangornConfig.rpcUrl;
const SDK_SUBSCRIPTION_ADDRESS = FangornConfig.subscriptionRegistryContractAddress;

// The SubscriptionRegistry view `access(address) -> (bool registered, uint64 paidAt)`.
// It cross-calls DataRegistry.isRegistered internally, so this single read gives the
// worker both the registration gate and the subscription timestamp. Stylus exposes
// the Rust method as camelCase.
const DEFAULT_ACCESS_FUNCTION = 'access(address)';

/**
 * Which SubscriptionRegistry to gate on. The SDK's, unless the deployment explicitly
 * overrides it.
 *
 * The override exists so a redeployed contract can be pointed at without waiting on an
 * SDK publish — the worker is the upload gate, and "all uploads 403" should not need a
 * package release to fix. It is loud on purpose: an override that silently disagreed
 * with the SDK is the failure this whole change is undoing, so taking one logs what it
 * replaced. Whoever sets it owns checking that the contract's `dataRegistry()` equals
 * the SDK's `dataRegistryContractAddress`:
 *
 *   cast call <override> "dataRegistry()(address)" --rpc-url <rpc>
 *
 * Still throws rather than falling back if neither is a usable address — gating on the
 * wrong contract silently is worse than failing.
 */
function subscriptionAddress(env) {
  const override = env.SUBSCRIPTION_CONTRACT_ADDRESS;
  if (override && override.toLowerCase() !== SDK_SUBSCRIPTION_ADDRESS.toLowerCase()) {
    console.warn(
      `SUBSCRIPTION_CONTRACT_ADDRESS override in use: gating on ${override}, `
      + `not the SDK's ${SDK_SUBSCRIPTION_ADDRESS}. Verify its dataRegistry() matches `
      + `${FangornConfig.dataRegistryContractAddress} or every wallet reads as unregistered.`);
  }
  const contract = override || SDK_SUBSCRIPTION_ADDRESS;
  if (!isAddress(contract)) {
    throw new Error(
      'No usable SubscriptionRegistry address: the Fangorn SDK supplied '
      + `"${SDK_SUBSCRIPTION_ADDRESS}" and SUBSCRIPTION_CONTRACT_ADDRESS is `
      + `"${override ?? 'unset'}". Upgrade @fangorn-network/sdk or set a valid override.`);
  }
  return contract;
}

/**
 * One `eth_call` to the SubscriptionRegistry's `access(address)` view, returning
 * `{ registered, paidAt }`. `registered` is the contract's cross-call to
 * DataRegistry.isRegistered; `paidAt` is the wallet's last subscription timestamp
 * (Unix seconds bigint, 0 if never). The worker applies the free-tier + active-
 * window policy itself.
 *
 * Env:
 *   RPC_URL                        EVM JSON-RPC endpoint (optional; defaults to the
 *                                  SDK's, currently the public Arbitrum Sepolia RPC).
 *   SUBSCRIPTION_CONTRACT_ADDRESS  Optional override of the SDK's address. An escape
 *                                  hatch for repointing ahead of an SDK publish, not
 *                                  routine config — see subscriptionAddress().
 *   ACCESS_FUNCTION                ABI signature (optional; default "access(address)").
 */
async function readAccess(env, address) {
  const rpcUrl = env.RPC_URL || DEFAULT_RPC_URL;
  const contract = subscriptionAddress(env);

  const data = toFunctionSelector(env.ACCESS_FUNCTION || DEFAULT_ACCESS_FUNCTION) + encodeAddress(address);

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

  // access() returns two 32-byte words: [0] bool registered, [1] uint64 paidAt.
  return { registered: wordAt(body.result, 0) !== 0n, paidAt: wordAt(body.result, 1) };
}

/**
 * Whether a subscription paid at `paidAt` (Unix seconds bigint, 0 = never) is still
 * active — within SUBSCRIPTION_WINDOW_DAYS (default 30) of now. The window lives
 * here, not on-chain, so it's tunable without a contract redeploy.
 */
function isWithinWindow(env, paidAt) {
  if (paidAt === 0n) return false;
  const windowSecs = BigInt(Number(env.SUBSCRIPTION_WINDOW_DAYS || 30) * 86400);
  return BigInt(Math.floor(Date.now() / 1000)) < paidAt + windowSecs;
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

// Lifetime free tier: a cumulative per-wallet byte allowance. Beyond it, each
// upload requires an active on-chain subscription. Opt-in like the daily cap:
// inactive unless FREE_BYTE_LIMIT > 0 and RATE_KV is bound.
function freeTierConfig(env) {
  const limit = Number(env.FREE_BYTE_LIMIT || 0);
  return { active: limit > 0 && !!env.RATE_KV, limit };
}

// One lifetime byte counter per wallet (no date segment, never expires).
function totalKey(address) {
  return `total:${address}`;
}

async function currentTotal(env, address) {
  return Number(await env.RATE_KV.get(totalKey(address))) || 0;
}

async function recordTotal(env, address, total, size) {
  await env.RATE_KV.put(totalKey(address), String(total + size));
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

const PINATA_API = 'https://api.pinata.cloud/v3';

/**
 * The Pinata group every one of `address`'s uploads is filed under, created on
 * first use. Groups are how a whole deployment's pins stay sweepable: a cleanup
 * job lists groups by name prefix and unpins their files, without needing any
 * record of what was uploaded.
 *
 * Name is `${PINATA_GROUP_PREFIX}:${address}` — per wallet, namespaced by
 * deployment. The prefix is REQUIRED: a pin filed under no group (or under an
 * unlabelled one) is a pin no cleanup job can find, which defeats the point, so
 * an unset prefix fails the request rather than minting.
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
