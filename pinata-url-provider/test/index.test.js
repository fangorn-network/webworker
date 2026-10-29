/**
 * Tests for the pinata-url-provider worker — one case per success/failure mode.
 *
 * The worker is a plain `(request, env) => Response` over standard Web APIs, so
 * we call it directly (no miniflare) and stub the three outbound `fetch`es it
 * makes: the AppRegistry eth_calls (RPC — the `access()` view, and the reads that
 * explain a denial), the Pinata groups API, and the Pinata `sign` endpoint.
 * Ownership signatures are real EIP-191 personal_signs via viem, the same lib the
 * worker uses to recover them.
 *
 * Run:  node --test   (from pinata-url-provider/)
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { toFunctionSelector } from 'viem';

import worker from '../src/index.js';
import { ArbitrumSepoliaConfig, BaseSepoliaConfig } from '@fangorn-network/sdk/lib/config.js';

/* ── outbound fetch stub ─────────────────────────────────────────────────── */
// Routes by URL: the Pinata sign endpoint → `pinataResponse`, the Pinata groups
// API → `groupsResponse`, else the RPC. A route left null that gets called
// throws, so tests catch stray calls. Groups are defaulted in `beforeEach`
// (every mint resolves one), and their calls recorded for assertions.
const realFetch = globalThis.fetch;
let rpcResponse = null;
let pinataResponse = null;
let groupsResponse = null;
let lastPinataInit = null; // request init captured from the Pinata sign call
let groupCalls = [];       // { url, init } per Pinata groups API call
let rpcCalls = [];         // parsed JSON-RPC body of each eth_call, in order

before(() => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('uploads.pinata.cloud')) {
      if (!pinataResponse) throw new Error('unexpected Pinata fetch');
      lastPinataInit = init;
      return pinataResponse();
    }
    if (u.includes('api.pinata.cloud')) {
      if (!groupsResponse) throw new Error('unexpected Pinata groups fetch');
      groupCalls.push({ url: u, init });
      return groupsResponse(u, init);
    }
    if (!rpcResponse) throw new Error('unexpected RPC fetch');
    rpcCalls.push(JSON.parse(init.body));
    return rpcResponse(u, init);
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  rpcResponse = null;
  pinataResponse = null;
  lastPinataInit = null;
  rpcCalls = [];
  groupCalls = [];
  // Default: no existing group → the worker creates one.
  groupsResponse = (u, init) =>
    init?.method === 'POST'
      ? jsonResponse(200, { data: { id: GROUP_ID } })
      : jsonResponse(200, { data: { groups: [], next_page_token: null } }); // Pinata's real shape
});

const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const wordHex = (n) => BigInt(n).toString(16).padStart(64, '0');
const pinataOk = () => jsonResponse(200, { data: 'https://uploads.pinata.cloud/signed/xyz' });
const GROUP_ID = 'ad4bc3bf-8794-49e7-94ff-fea1ce745779';

/* ── request/proof helpers ───────────────────────────────────────────────── */
const BASE_URL = 'https://worker.test/';
const nowSec = () => Math.floor(Date.now() / 1000);

// Three throwaway deterministic keys (never use anywhere real). OWNER stands in
// for the app owner whose app pays for the upload.
const ACCOUNT = privateKeyToAccount('0x' + '11'.repeat(32));
const OTHER = privateKeyToAccount('0x' + '22'.repeat(32));
const OWNER = privateKeyToAccount('0x' + '33'.repeat(32));

/* ── eth_call stub ───────────────────────────────────────────────────────── */
// Routes eth_calls by selector: the AppRegistry `access(appId, address)` view —
// three 32-byte words, (bool canPublish, address owner, uint64 expiresAt) — and
// the three reads that explain a denial. The defaults describe a publisher the
// app has accepted, in an app paid up for another 30 days.
const APP_ID = '0x' + 'ab'.repeat(32);
const OTHER_APP_ID = '0x' + 'cd'.repeat(32);
const SELECTOR = {
  access: toFunctionSelector('access(bytes32,address)'),
  appSuspended: toFunctionSelector('isAppSuspended(bytes32)'),
  banned: toFunctionSelector('globalSuspensions(address)'),
  status: toFunctionSelector('statusForApp(bytes32,address)'),
  canonical: toFunctionSelector('canonicalAppId(bytes32)'),
};
const callsTo = (selector) => rpcCalls.filter((c) => c.params[0].data.startsWith(selector));

function appRpc({
  canPublish = true,           // access().canPublish
  appSuspended = false,        // taken down by the protocol admin
  banned = false,              // banned network-wide by the protocol admin
  status = canPublish ? 1 : 0, // 0 None, 1 Active, 2 Suspended
  owner = OWNER.address,
  expiresAt = nowSec() + 30 * 86400,
  canonical = null,            // canonicalAppId(): null → the id asked about (no alias)
} = {}) {
  return (_url, init) => {
    const data = JSON.parse(init.body).params[0].data;
    switch (data.slice(0, 10)) {
      case SELECTOR.access:
        return jsonResponse(200, {
          result: '0x' + wordHex(canPublish ? 1 : 0) + wordHex(BigInt(owner)) + wordHex(expiresAt),
        });
      case SELECTOR.appSuspended:
        return jsonResponse(200, { result: '0x' + wordHex(appSuspended ? 1 : 0) });
      case SELECTOR.banned:
        return jsonResponse(200, { result: '0x' + wordHex(banned ? 1 : 0) });
      case SELECTOR.status:
        return jsonResponse(200, { result: '0x' + wordHex(status) });
      case SELECTOR.canonical:
        return jsonResponse(200, { result: canonical ?? '0x' + data.slice(10, 74) });
      default:
        throw new Error(`unexpected eth_call selector ${data.slice(0, 10)}`);
    }
  };
}
const acceptedRpc = appRpc();

function baseEnv(overrides = {}) {
  return {
    PINATA_JWT: 'test-jwt',
    PINATA_GROUP_PREFIX: 'testnet',
    // No contract addresses: the gate contracts come from the SDK.
    ...overrides,
  };
}

// Mirror of the worker's canonical challenge template (see buildChallengeMessage).
function challengeMessage(address, appId, issuedAt) {
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

// A valid { address, appId, message, signature } proof for `account`, signed for
// `signedFor` (the request's app, unless a test says otherwise).
async function proof(account = ACCOUNT, { issuedAt = nowSec(), address = account.address, appId = APP_ID, signedFor = appId } = {}) {
  const message = challengeMessage(address, signedFor, issuedAt);
  const signature = await account.signMessage({ message });
  return { address, appId, message, signature };
}

async function call(env, { method = 'POST', body, query, headers } = {}) {
  const url = new URL(BASE_URL);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const init = { method, headers: { ...(headers || {}) } };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await worker.fetch(new Request(url, init), env);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

// In-memory Workers KV stub: just enough of get/put for the rate-cap tests.
function mockKV(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]));
  return {
    get: async (k) => (store.has(k) ? store.get(k) : null),
    put: async (k, v) => void store.set(k, String(v)),
    _store: store,
  };
}

const utcDay = () => new Date().toISOString().slice(0, 10);
// Byte counters are per app: the app is what pays.
const usageKey = (appId) => `bytes:${appId}:${utcDay()}`;
const groupName = (appId, account = ACCOUNT) => `testnet:${appId.slice(2, 14)}:${account.address.toLowerCase().slice(2, 14)}`;

/* ── success modes ───────────────────────────────────────────────────────── */

test('OPTIONS preflight → 204 with CORS headers', async () => {
  const res = await call(baseEnv(), { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('accepted by the app + valid signature → 200 with uploadUrl', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.uploadUrl, 'https://uploads.pinata.cloud/signed/xyz');
  // The whole grant costs two chain reads, made together: access(app, caller) and
  // canonicalAppId(app).
  assert.equal(rpcCalls.length, 2);
  assert.equal(callsTo(SELECTOR.canonical)[0].params[0].data, SELECTOR.canonical + APP_ID.slice(2));
  // access(appId, caller): selector, then the two argument words.
  assert.equal(
    callsTo(SELECTOR.access)[0].params[0].data,
    SELECTOR.access + APP_ID.slice(2) + ACCOUNT.address.slice(2).toLowerCase().padStart(64, '0'),
  );
});

test('the app\'s owner → 200 (accepted when they claimed it)', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof(OWNER) });
  assert.equal(res.status, 200);
});

test('PINATA_ALLOW_MIME_TYPES → forwarded to Pinata as a trimmed allow_mime_types', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  // Spaces after the comma also exercise the worker's per-entry .trim().
  const env = baseEnv({ PINATA_ALLOW_MIME_TYPES: 'application/octet-stream, text/plain' });
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 200);
  const payload = JSON.parse(lastPinataInit.body);
  assert.deepEqual(payload.allow_mime_types, ['application/octet-stream', 'text/plain']);
});

/* ── per-app, per-wallet Pinata group ────────────────────────────────────── */

test('mint files the upload under a group named <prefix>:<appId12>:<wallet12>', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  // Signed into the upload URL, so the uploader can't file the pin elsewhere.
  assert.equal(JSON.parse(lastPinataInit.body).group_id, GROUP_ID);
  const name = groupName(APP_ID);
  assert.equal(JSON.parse(groupCalls.at(-1).init.body).name, name);
  assert.match(groupCalls[0].url, new RegExp(`name=${encodeURIComponent(name)}`));
});

test('an existing group is adopted by name, not duplicated', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const name = groupName(APP_ID);
  // Substring match — the worker must pick the exact name, not groups[0].
  groupsResponse = () => jsonResponse(200, { data: { groups: [{ id: 'other', name: `${name}-old` }, { id: GROUP_ID, name }] } });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(lastPinataInit.body).group_id, GROUP_ID);
  assert.equal(groupCalls.length, 1); // looked up, never created
});

test('the wallet→group id is cached in KV across mints', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ RATE_KV: kv });
  const p = await proof();
  await call(env, { body: p });
  const afterFirst = groupCalls.length;
  await call(env, { body: p });
  assert.equal(kv._store.get(`group:${groupName(APP_ID)}`), GROUP_ID);
  assert.equal(groupCalls.length, afterFirst); // second mint hit the cache
});

test('group names fit Pinata\'s 50-character cap (a longer one is a 400)', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  // The deployed prefix, with a full-length app id and wallet: the case that broke every first upload.
  const res = await call(baseEnv({ PINATA_GROUP_PREFIX: 'testnet-base' }), { body: await proof() });
  assert.equal(res.status, 200);
  const name = JSON.parse(groupCalls.at(-1).init.body).name;
  assert.ok(name.length <= 50, `${name} is ${name.length} characters`);
  assert.equal(name, `testnet-base:${APP_ID.slice(2, 14)}:${ACCOUNT.address.toLowerCase().slice(2, 14)}`);
});

test('a PINATA_GROUP_PREFIX too long for the cap → 502 with the reason, never mints', async () => {
  rpcResponse = acceptedRpc; // pinataResponse null: a mint would throw
  const res = await call(baseEnv({ PINATA_GROUP_PREFIX: 'x'.repeat(30) }), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.detail, /too long/);
  assert.equal(groupCalls.length, 0);
});

test('missing PINATA_GROUP_PREFIX → 502 and never mints', async () => {
  rpcResponse = acceptedRpc; // pinataResponse null: a mint would throw
  const env = baseEnv();
  delete env.PINATA_GROUP_PREFIX;
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 502);
  assert.equal(groupCalls.length, 0);
});

test('GET with proof in query params → 200', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { method: 'GET', query: await proof() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

/* ── failure modes ───────────────────────────────────────────────────────── */

test('unsupported method → 405', async () => {
  const res = await call(baseEnv(), { method: 'PUT' });
  assert.equal(res.status, 405);
});

test('the gate reads Base Sepolia\'s AppRegistry from the SDK, not Arbitrum\'s', async () => {
  rpcResponse = appRpc({ canPublish: false }); // a denial makes every read the worker has
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 403);
  // The `to` of each eth_call IS the deployment gated on. Asserting it against the
  // SDK is what catches the worker sitting on a stale registry while the SDK has
  // moved on.
  assert.equal(rpcCalls.length, 5);
  for (const c of rpcCalls) {
    assert.equal(c.params[0].to.toLowerCase(), BaseSepoliaConfig.appRegistryContractAddress.toLowerCase());
  }
  // TODO: we should probably just deprecate the arbitrum piece
  assert.notEqual(BaseSepoliaConfig.appRegistryContractAddress, ArbitrumSepoliaConfig.appRegistryContractAddress);
});

test('the RPC defaults to the SDK\'s Base Sepolia endpoint, and RPC_URL overrides it', async () => {
  const urls = [];
  rpcResponse = (url, init) => (urls.push(url), acceptedRpc(url, init));
  pinataResponse = pinataOk;
  await call(baseEnv(), { body: await proof() });
  await call(baseEnv({ RPC_URL: 'https://rpc.example/' }), { body: await proof() });
  assert.deepEqual(urls, [BaseSepoliaConfig.rpcUrl, BaseSepoliaConfig.rpcUrl, 'https://rpc.example/', 'https://rpc.example/']);
});

test('invalid address → 400', async () => {
  const res = await call(baseEnv(), { body: { address: 'not-an-address' } });
  assert.equal(res.status, 400);
});

test('missing address → 400', async () => {
  const res = await call(baseEnv(), { body: {} });
  assert.equal(res.status, 400);
});

test('no signature yet → 401 with a challenge to sign, naming the app', async () => {
  const res = await call(baseEnv(), { body: { address: ACCOUNT.address, appId: APP_ID } });
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /Sign the .challenge. message/);
  assert.match(res.json.challenge, /Fangorn onchain-gate access request/);
  assert.match(res.json.challenge, new RegExp(`^App: ${APP_ID}$`, 'm'));
});

test('a signature made for another app → 401, never reaches the chain', async () => {
  // rpcResponse stays null: a chain read would throw.
  const p = await proof(ACCOUNT, { appId: APP_ID, signedFor: OTHER_APP_ID });
  const res = await call(baseEnv(), { body: p });
  assert.equal(res.status, 401);
  assert.match(res.json.error, /Verification failed/);
});

test('signature from the wrong key → 401 verification failed', async () => {
  // Message claims ACCOUNT's address, but OTHER signed it → recovered ≠ address.
  const message = challengeMessage(ACCOUNT.address, APP_ID, nowSec());
  const signature = await OTHER.signMessage({ message });
  const res = await call(baseEnv(), { body: { address: ACCOUNT.address, appId: APP_ID, message, signature } });
  assert.equal(res.status, 401);
  assert.match(res.json.error, /Verification failed/);
});

test('tampered challenge message → 401', async () => {
  const p = await proof();
  const res = await call(baseEnv(), { body: { ...p, message: p.message + ' tampered' } });
  assert.equal(res.status, 401);
  assert.match(res.json.error, /Verification failed/);
});

test('stale challenge (Issued-At too old) → 401', async () => {
  const p = await proof(ACCOUNT, { issuedAt: nowSec() - 10_000 });
  const res = await call(baseEnv({ SIGNATURE_MAX_AGE: '300' }), { body: p });
  assert.equal(res.status, 401);
  assert.match(res.json.error, /Verification failed/);
});

test('wallet banned network-wide → 403 that says so (never mints)', async () => {
  // The ban hides an otherwise accepted publisher.
  rpcResponse = appRpc({ canPublish: false, banned: true, status: 1 }); // pinataResponse null: a mint would throw
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /suspended from publishing on Fangorn/i);
  assert.equal(groupCalls.length, 0);
});

test('RPC failure → 502', async () => {
  rpcResponse = () => jsonResponse(500, { error: 'rpc down' });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /checking onchain access/i);
});

test('Pinata sign failure → 502', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = () => jsonResponse(500, { error: 'nope' });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Failed to create Pinata upload URL/);
});

test('missing PINATA_JWT → 502', async () => {
  rpcResponse = acceptedRpc; // JWT check happens after the gate passes
  const env = baseEnv();
  delete env.PINATA_JWT;
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Failed to create Pinata upload URL/);
});

/* ── per-app byte budget ─────────────────────────────────────────────────── */

test('declared size under budget → 200, URL scoped to size, debits bytes', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(APP_ID)]: 1000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.maxFileSize, 4000 + 64 + 4096);              // requested + one chunk's DAG overhead + slack
  assert.equal(kv._store.get(usageKey(APP_ID)), '5000');       // 1000 + declared 4000
});

test('requested size over the per-upload ceiling → 413 (no mint)', async () => {
  rpcResponse = acceptedRpc; // pinataResponse null: a mint would throw
  const env = baseEnv({ MAX_UPLOAD_SIZE: '5000' });
  const res = await call(env, { body: { ...(await proof()), size: 6000 } });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /per-upload maximum/i);
});

test('declared size over remaining budget → 429 and never mints', async () => {
  rpcResponse = acceptedRpc; // pinataResponse null: a mint would throw
  const kv = mockKV({ [usageKey(APP_ID)]: 9000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 429);
  assert.match(res.json.error, /budget reached/i);
  assert.equal(kv._store.get(usageKey(APP_ID)), '9000'); // unchanged — no grant
});

test('failed mint does not consume budget', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = () => jsonResponse(500, { error: 'nope' });
  const kv = mockKV({ [usageKey(APP_ID)]: 100 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 502);
  assert.equal(kv._store.get(usageKey(APP_ID)), '100'); // no grant, no charge
});

test('retry with same uploadId re-mints but is charged once', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(APP_ID)]: 1000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const body = { ...(await proof()), size: 3000, uploadId: 'up-1' };
  const first = await call(env, { body });
  const second = await call(env, { body }); // same uploadId = a retry
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);       // re-mints a fresh URL
  assert.equal(kv._store.get(usageKey(APP_ID)), '4000'); // 1000 + 3000 once, not twice
});

test('reusing an uploadId for a larger size is charged the larger size', async () => {
  rpcResponse = acceptedRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(APP_ID)]: 0 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const p = await proof();
  await call(env, { body: { ...p, size: 2000, uploadId: 'up-2' } }); // pays 2000
  await call(env, { body: { ...p, size: 5000, uploadId: 'up-2' } }); // larger → charged
  assert.equal(kv._store.get(usageKey(APP_ID)), '7000'); // 2000 + 5000
});

/* ── the app's subscription ──────────────────────────────────────────────── */

test('expired or cancelled app → 402 naming the owner (never mints, never billed)', async () => {
  // 0 is a cancelled subscription; the contract already refuses both in canPublish.
  for (const expiresAt of [nowSec() - 86400, 0]) {
    rpcResponse = appRpc({ canPublish: false, status: 1, expiresAt }); // pinataResponse null: a mint would throw
    const kv = mockKV();
    const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', RATE_KV: kv });
    const res = await call(env, { body: { ...(await proof()), size: 1 } });
    assert.equal(res.status, 402);
    assert.match(res.json.error, new RegExp(`app ${APP_ID} has expired`));
    assert.match(res.json.error, new RegExp(OWNER.address, 'i'));
    assert.match(res.json.error, /fangorn\.network/); // default SUBSCRIBE_URL
    assert.equal(kv._store.size, 0); // no grant, no charge
    assert.equal(groupCalls.length, 0);
  }
});

/* ── app membership (every request) ──────────────────────────────────────── */

test('no appId → 400 before any chain call (there is no default app)', async () => {
  // rpcResponse stays null: a chain read would throw.
  const { appId: _, ...withoutApp } = await proof();
  const res = await call(baseEnv(), { body: withoutApp });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /appId/);
});

test('never accepted by the app → 403 saying to ask its owner (never mints)', async () => {
  rpcResponse = appRpc({ canPublish: false, status: 0 }); // pinataResponse null: a mint would throw
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, new RegExp(`not been accepted by app ${APP_ID}`));
  assert.match(res.json.error, /owner to accept/);
  assert.equal(groupCalls.length, 0);
});

test('app taken down → 403 that names the takedown (never mints)', async () => {
  // Acceptance survives a takedown, so the caller is still Active underneath.
  rpcResponse = appRpc({ canPublish: false, appSuspended: true, status: 1 });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, new RegExp(`App ${APP_ID} has been taken down`));
  assert.equal(groupCalls.length, 0);
});

test('publisher suspended from the app → 403 that names the suspension (never mints)', async () => {
  rpcResponse = appRpc({ canPublish: false, status: 2 });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, new RegExp(`suspended from app ${APP_ID}`));
  assert.equal(groupCalls.length, 0);
});

test('refused with no cause the reads can name → still 403 (never mints)', async () => {
  // The chain's clock passed the expiry before the worker's did: access() is the rule.
  rpcResponse = appRpc({ canPublish: false, status: 1 });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /may not publish/);
  assert.equal(groupCalls.length, 0);
});

test('RPC failure while explaining a denial → 502 (never mints)', async () => {
  const denied = appRpc({ canPublish: false });
  rpcResponse = (url, init) =>
    JSON.parse(init.body).params[0].data.startsWith(SELECTOR.status)
      ? jsonResponse(500, { error: 'rpc down' })
      : denied(url, init);
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /checking onchain access/i);
});

/* ── app-scoped uploads ──────────────────────────────────────────────────── */

test('appId → group is <prefix>:<appId>:<wallet>, and bytes bill that app only', async () => {
  rpcResponse = appRpc();
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof(ACCOUNT, { appId: OTHER_APP_ID })), size: 4000 } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(groupCalls.at(-1).init.body).name, groupName(OTHER_APP_ID));
  assert.equal(kv._store.get(usageKey(OTHER_APP_ID)), '4000');
  assert.equal(kv._store.get(usageKey(APP_ID)), undefined);
});

test('one daily budget covers every publisher of an app', async () => {
  rpcResponse = appRpc();
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ DAILY_BYTE_LIMIT: '5000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const first = await call(env, { body: { ...(await proof(ACCOUNT)), size: 3000, appId: APP_ID } });
  const second = await call(env, { body: { ...(await proof(OTHER)), size: 3000, appId: APP_ID } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429); // a different wallet, the same app's budget
  assert.equal(kv._store.get(usageKey(APP_ID)), '3000');
});

test('an alias (renamed app) bills and files under the canonical id', async () => {
  // OTHER_APP_ID is an alias of APP_ID: the contract gates on either, and the worker
  // must not give the alias a budget or Pinata groups of its own.
  rpcResponse = appRpc({ canonical: APP_ID });
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(APP_ID)]: 9000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', RATE_KV: kv });
  const ok = await call(env, { body: { ...(await proof(ACCOUNT, { appId: OTHER_APP_ID })), size: 500, uploadId: 'u1' } });
  assert.equal(ok.status, 200);
  assert.equal(kv._store.get(usageKey(APP_ID)), '9500');
  assert.equal(kv._store.has(usageKey(OTHER_APP_ID)), false);
  assert.equal(JSON.parse(groupCalls.at(-1).init.body).name, groupName(APP_ID));
  // The alias shares the canonical app's budget, so it can't mint past it.
  const over = await call(env, { body: { ...(await proof(ACCOUNT, { appId: OTHER_APP_ID })), size: 600 } });
  assert.equal(over.status, 429);
});

test('unclaimed app (owner 0x0) → 403, never billed', async () => {
  rpcResponse = appRpc({ canPublish: false, owner: '0x' + '0'.repeat(40), expiresAt: 0 });
  const kv = mockKV();
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', RATE_KV: kv });
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /has not been claimed/i);
  assert.equal(kv._store.size, 0);
  assert.equal(rpcCalls.length, 2); // explained by access() alone (canonicalAppId() rides along)
});

test('malformed appId → 400 before any chain call', async () => {
  const res = await call(baseEnv(), { body: await proof(ACCOUNT, { appId: '0xdeadbeef' }) });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /32-byte hex/);
});

/* ── usage endpoint ──────────────────────────────────────────────────────── */

test('GET /usage → an app\'s byte counter + limit (no proof, one RPC)', async () => {
  rpcResponse = acceptedRpc; // canonicalAppId() only; pinataResponse stays null
  const kv = mockKV({ [usageKey(APP_ID)]: 200, [usageKey(OTHER_APP_ID)]: 7 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '5000', RATE_KV: kv });
  const res = await worker.fetch(new Request(`https://worker.test/usage?appId=${APP_ID}`), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.appId, APP_ID);
  assert.equal(body.daily, 200);
  assert.equal(body.dailyLimit, 5000);
});

test('GET /usage for an alias reads the canonical app\'s counter', async () => {
  rpcResponse = appRpc({ canonical: APP_ID });
  const kv = mockKV({ [usageKey(APP_ID)]: 200 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '5000', RATE_KV: kv });
  const res = await worker.fetch(new Request(`https://worker.test/usage?appId=${OTHER_APP_ID}`), env);
  const body = await res.json();
  assert.equal(body.appId, OTHER_APP_ID);
  assert.equal(body.daily, 200);
});

test('GET /usage with a bad or missing appId → 400 (there is no default app)', async () => {
  for (const q of ['?appId=nope', '']) {
    const res = await worker.fetch(new Request(`https://worker.test/usage${q}`), baseEnv());
    assert.equal(res.status, 400);
  }
});
