/**
 * pinata-url-provider — a self-contained Cloudflare Worker.
 *
 * Flow:
 *   1. The caller proves control of an address by signing a one-time challenge
 *      (EIP-191 `personal_sign`). If the signature doesn't verify, the request is
 *      rejected with "Verification failed…" — see `verifyCallerOwnsAddress()`.
 *   2. The worker reads the caller's network-wide standing from the DataRegistry
 *      (`getPublisherStatus`) and, in the same round, `access(appId, address)` from
 *      the AppRegistry — both Stylus contracts on Arbitrum Sepolia, addresses from
 *      the Fangorn SDK. This can be stubbed for local dev with
 *      STUB_REGISTRATION_CHECK="true".
 *   2b. Nobody publishes outside an app, and an app IS a storage subscription. The
 *      caller must be an active publisher of the app they publish to (the `appId`
 *      they pass, else the SDK's default app): added by its owner, on its current
 *      terms, not suspended. And the app must have paid within
 *      SUBSCRIPTION_WINDOW_DAYS. Every byte is billed to the app.
 *   3. If all of that holds, the worker mints a short-lived Pinata *presigned upload
 *      URL* and returns it, so the caller can pin one file to IPFS without ever
 *      seeing your Pinata JWT.
 *
 * Dependencies are `viem` (signature recovery + selector encoding) and the Fangorn
 * SDK, which supplies the deployment addresses. Everything else is driven by
 * environment variables (see wrangler.toml / README).
 */

import { recoverMessageAddress, toFunctionSelector } from 'viem';
// Deep import on purpose: `lib/config.js` pulls in nothing but viem, while the SDK's
// package root reaches the harness (node `fs`/`path`) and the graph engine — none of
// which a workerd bundle can or should carry.
import { DEFAULT_APP, FangornConfig, toAppId } from '@fangorn-network/sdk/lib/config.js';

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
      const usageApp = (url.searchParams.get('appId') || DEFAULT_APP_ID).toLowerCase();
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

    // The app this upload lands in — and is billed to. Every publish lands in an
    // app, so a caller who names none means the SDK's default one, the same
    // fallback the SDK applies to the commit that follows.
    const appId = (input.appId || DEFAULT_APP_ID).toLowerCase();
    if (!isBytes32(appId)) {
      return json(400, { error: 'appId must be a 32-byte hex string (0x + 64 hex chars).' }, cors);
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

    // 1) On-chain gate — two reads, one round: the caller's network-wide standing,
    // and the AppRegistry's `access` view for (app, caller). STUB_REGISTRATION_CHECK
    // skips the chain entirely (a valid signature alone suffices — dev/testing
    // without an RPC), and the subscription then reads as active.
    const stubbed = (env.STUB_REGISTRATION_CHECK ?? 'false') === 'true';
    if (!stubbed) {
      const registerUrl = env.REGISTER_URL || 'https://fangorn.network';
      let access;
      try {
        const [status, appAccess] = await Promise.all([
          readPublisherStatus(env, address),
          readAccess(env, appId, address),
        ]);
        if (status !== STATUS_ACTIVE) {
          return json(403, {
            ok: false,
            address,
            // A suspended wallet reads as "not registered" to a boolean check,
            // and telling them to register is the wrong advice.
            error: status === STATUS_SUSPENDED
              ? 'This public key has been suspended from publishing on Fangorn.'
              : `This public key is not registered. Please login on ${registerUrl} to register.`,
          }, cors);
        }
        access = appAccess;
        if (access.owner === ZERO_ADDRESS) {
          // Unclaimed app: there is no subscription to bill and nobody to be a
          // publisher of it.
          return json(403, { ok: false, address, error: `App ${appId} has no owner on-chain.` }, cors);
        }
        // Membership is what DataRegistry.commitStateRoot enforces too, so a URL is
        // never minted for a push that would revert.
        if (!access.registered) {
          return json(403, { ok: false, address, error: await appDenialReason(env, appId, address) }, cors);
        }
      } catch (err) {
        return json(502, { error: 'On-chain access check failed.', detail: String(err?.message || err) }, cors);
      }

      // The app's subscription must be active: paid within the window. There is
      // no free tier — claiming an app is paying for it, so every app has paid at
      // least once and a lapsed one stops here until its owner renews.
      if (!isWithinWindow(env, access.paidAt)) {
        const subscribeUrl = env.SUBSCRIBE_URL || 'https://fangorn.network/subscribe';
        return json(402, {
          ok: false,
          address,
          error: `The storage subscription for app ${appId} is inactive. Its owner (${access.owner}) must renew it at ${subscribeUrl}`,
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

    // 2) Granted (or stubbed) — issue a Pinata presigned upload URL scoped to
    // the requested size (plus a little multipart/form-data headroom).
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
        ...(stubbed ? { stubbed: true } : {}),
      }, cors);
    } catch (err) {
      return json(502, { error: 'Failed to create Pinata upload URL.', detail: String(err?.message || err) }, cors);
    }
  },
};

/* ───────────────────────── on-chain access gate ────────────────────────── */

// The deployment comes from the SDK, which is the only thing that knows which
// contracts belong together: the AppRegistry gated on here must be the one the
// SDK's DataRegistry consults on `commitStateRoot`, or the gate and the commit
// disagree about who may publish. So neither address is configurable — the SDK
// version bump is the repoint.
const DEFAULT_RPC_URL = FangornConfig.rpcUrl;
const SDK_APP_REGISTRY_ADDRESS = FangornConfig.appRegistryContractAddress;
const SDK_DATA_REGISTRY_ADDRESS = FangornConfig.dataRegistryContractAddress;

// The AppRegistry view `access(bytes32 appId, address) -> (bool registered,
// address owner, uint64 paidAt)`: one read for membership, who owns the app, and
// when its subscription was last paid. `registered` is `isRegisteredForApp` (false
// for a suspended app, a suspended or merely-invited publisher, or stale accepted
// terms). Stylus exposes the Rust method as camelCase.
const ACCESS_FUNCTION = 'access(bytes32,address)';
// Read only to explain a denial — see appDenialReason().
const APP_SUSPENDED_FUNCTION = 'isAppSuspended(bytes32)';
const APP_STATUS_FUNCTION = 'statusForApp(bytes32,address)';
// DataRegistry's network-wide lifecycle status.
const PUBLISHER_STATUS_FUNCTION = 'getPublisherStatus(address)';
// Lifecycle codes shared by both registries (0 = unregistered). INVITED exists only
// per app: added by the owner, terms not yet accepted.
const STATUS_ACTIVE = 1n;
const STATUS_SUSPENDED = 2n;
const STATUS_INVITED = 3n;
const ZERO_ADDRESS = '0x' + '0'.repeat(40);
// The app a publish lands in when the caller names none — the same fallback the SDK
// applies to its registry clients, so the check here matches the commit that follows.
const DEFAULT_APP_ID = toAppId(DEFAULT_APP);

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
 * `getPublisherStatus(address)` on the DataRegistry: the caller's network-wide
 * standing (0 unregistered, 1 active, 2 suspended). App membership alone is not
 * enough to publish — the DataRegistry rejects a commit from a wallet that never
 * registered, or that the protocol admin suspended.
 */
async function readPublisherStatus(env, address) {
  const result = await ethCall(
    env, sdkAddress(SDK_DATA_REGISTRY_ADDRESS, 'dataRegistryContractAddress'),
    PUBLISHER_STATUS_FUNCTION, [encodeAddress(address)]);
  return wordAt(result, 0);
}

/**
 * One `eth_call` to the AppRegistry's `access(appId, address)` view, returning
 * `{ registered, owner, paidAt }`. `owner` is the zero address for an unclaimed
 * app; `paidAt` is the app's last subscription payment (Unix seconds bigint). The
 * worker applies the active-window policy itself.
 *
 * Env:
 *   RPC_URL   EVM JSON-RPC endpoint (optional; defaults to the SDK's, currently the
 *             public Arbitrum Sepolia RPC).
 */
async function readAccess(env, appId, address) {
  const result = await ethCall(
    env, sdkAddress(SDK_APP_REGISTRY_ADDRESS, 'appRegistryContractAddress'),
    ACCESS_FUNCTION, [encodeBytes32(appId), encodeAddress(address)]);
  // Three 32-byte words: [0] bool registered, [1] address owner, [2] uint64 paidAt.
  return { registered: wordAt(result, 0) !== 0n, owner: addressAt(result, 1), paidAt: wordAt(result, 2) };
}

/**
 * Why `access` said the caller is not registered. That bool folds several causes
 * into one, and the right advice differs for each, so ask the AppRegistry which it
 * was. Failure path only — a granted upload makes neither of these reads.
 */
async function appDenialReason(env, appId, address) {
  const apps = sdkAddress(SDK_APP_REGISTRY_ADDRESS, 'appRegistryContractAddress');
  const id = encodeBytes32(appId);
  const [suspended, status] = await Promise.all([
    ethCall(env, apps, APP_SUSPENDED_FUNCTION, [id]),
    ethCall(env, apps, APP_STATUS_FUNCTION, [id, encodeAddress(address)]),
  ]);
  const registerUrl = env.REGISTER_URL || 'https://fangorn.network';
  if (wordAt(suspended, 0) !== 0n) return `App ${appId} is suspended.`;
  switch (wordAt(status, 0)) {
    case STATUS_SUSPENDED:
      return `This public key is suspended from app ${appId}.`;
    case STATUS_ACTIVE:
      // Still a member, but on a terms hash the app has since moved off (or the
      // app has none set).
      return `This public key has not accepted the current terms of app ${appId}. Please accept them on ${registerUrl}.`;
    case STATUS_INVITED:
      return `This public key was added to app ${appId} but has not accepted its terms yet. Please join the app on ${registerUrl}.`;
    default:
      // Membership is by invitation — there is nothing the caller can do alone.
      return `This public key is not a publisher of app ${appId}. Ask the app's owner to add it.`;
  }
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
 * Name is `${PINATA_GROUP_PREFIX}:${appId}:${address}` — per wallet, namespaced by
 * deployment and by app, so an app's pins sweep as a unit and stay attributable to
 * the publisher. The prefix is REQUIRED: a pin filed under no
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
  const name = `${prefix}:${appId}:${address}`;
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
