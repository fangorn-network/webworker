/**
 * Tests for the pinata-url-provider worker — one case per success/failure mode.
 *
 * The worker is a plain `(request, env) => Response` over standard Web APIs, so
 * we call it directly (no miniflare) and stub the three outbound `fetch`es it
 * makes: the registry eth_calls (RPC — the DataRegistry status and the AppRegistry
 * `access()` view), the Pinata groups API, and the Pinata `sign` endpoint. Ownership signatures are real EIP-191
 * personal_signs via viem, the same lib the worker uses to recover them.
 *
 * Run:  node --test   (from pinata-url-provider/)
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { toFunctionSelector } from 'viem';

import worker from '../src/index.js';
import { DEFAULT_APP, FangornConfig, toAppId } from '@fangorn-network/sdk/lib/config.js';

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
      : jsonResponse(200, { groups: [] });
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
// Routes eth_calls by selector: the caller's DataRegistry status, the AppRegistry
// `access(appId, address)` view — three 32-byte words, (bool registered, address
// owner, uint64 paidAt) — and the two reads that explain a denial. The defaults
// describe a publisher in good standing, in an app whose subscription was paid
// just now.
const APP_ID = '0x' + 'ab'.repeat(32);
const DEFAULT_APP_ID = toAppId(DEFAULT_APP);
const SELECTOR = {
  access: toFunctionSelector('access(bytes32,address)'),
  appSuspended: toFunctionSelector('isAppSuspended(bytes32)'),
  status: toFunctionSelector('statusForApp(bytes32,address)'),
  publisherStatus: toFunctionSelector('getPublisherStatus(address)'),
};
const callsTo = (selector) => rpcCalls.filter((c) => c.params[0].data.startsWith(selector));

function appRpc({
  publisherStatus = 1,      // DataRegistry: 0 unregistered, 1 active, 2 suspended
  member = true,            // access().registered
  appSuspended = false,
  status = member ? 1 : 0,  // AppRegistry, per app: the same codes, plus 3 invited
  owner = OWNER.address,
  paidAt = nowSec(),
} = {}) {
  return (_url, init) => {
    const data = JSON.parse(init.body).params[0].data;
    switch (data.slice(0, 10)) {
      case SELECTOR.access:
        return jsonResponse(200, {
          result: '0x' + wordHex(member ? 1 : 0) + wordHex(BigInt(owner)) + wordHex(paidAt),
        });
      case SELECTOR.appSuspended:
        return jsonResponse(200, { result: '0x' + wordHex(appSuspended ? 1 : 0) });
      case SELECTOR.status:
        return jsonResponse(200, { result: '0x' + wordHex(status) });
      case SELECTOR.publisherStatus:
        return jsonResponse(200, { result: '0x' + wordHex(publisherStatus) });
      default:
        throw new Error(`unexpected eth_call selector ${data.slice(0, 10)}`);
    }
  };
}
const registeredRpc = appRpc();

function baseEnv(overrides = {}) {
  return {
    PINATA_JWT: 'test-jwt',
    PINATA_GROUP_PREFIX: 'testnet',
    STUB_REGISTRATION_CHECK: 'false',
    // No contract addresses: the gate contracts come from the SDK.
    ...overrides,
  };
}

// Mirror of the worker's canonical challenge template (see buildChallengeMessage).
function challengeMessage(address, issuedAt) {
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

// A valid { address, message, signature } proof for `account`.
async function proof(account = ACCOUNT, { issuedAt = nowSec(), address = account.address } = {}) {
  const message = challengeMessage(address, issuedAt);
  const signature = await account.signMessage({ message });
  return { address, message, signature };
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
const groupName = (appId, account = ACCOUNT) => `testnet:${appId}:${account.address.toLowerCase()}`;

/* ── success modes ───────────────────────────────────────────────────────── */

test('OPTIONS preflight → 204 with CORS headers', async () => {
  const res = await call(baseEnv(), { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('stubbed registration + valid signature → 200 with uploadUrl (no RPC call)', async () => {
  pinataResponse = pinataOk; // rpcResponse stays null: stub must not hit the chain
  const res = await call(baseEnv({ STUB_REGISTRATION_CHECK: 'true' }), { body: await proof() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.uploadUrl, 'https://uploads.pinata.cloud/signed/xyz');
  assert.equal(res.json.stubbed, true);
});

test('registered on-chain + valid signature → 200 with uploadUrl', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.uploadUrl, 'https://uploads.pinata.cloud/signed/xyz');
  assert.equal(res.json.stubbed, undefined);
  // The whole grant costs two chain reads: who the caller is, and where they stand
  // in the app.
  assert.equal(rpcCalls.length, 2);
});

test('PINATA_ALLOW_MIME_TYPES → forwarded to Pinata as a trimmed allow_mime_types', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  // Spaces after the comma also exercise the worker's per-entry .trim().
  const env = baseEnv({ PINATA_ALLOW_MIME_TYPES: 'application/octet-stream, text/plain' });
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 200);
  const payload = JSON.parse(lastPinataInit.body);
  assert.deepEqual(payload.allow_mime_types, ['application/octet-stream', 'text/plain']);
});

/* ── per-app, per-wallet Pinata group ────────────────────────────────────── */

test('mint files the upload under a group named <prefix>:<appId>:<wallet>', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  // Signed into the upload URL, so the uploader can't file the pin elsewhere.
  assert.equal(JSON.parse(lastPinataInit.body).group_id, GROUP_ID);
  const name = groupName(DEFAULT_APP_ID);
  assert.equal(JSON.parse(groupCalls.at(-1).init.body).name, name);
  assert.match(groupCalls[0].url, new RegExp(`name=${encodeURIComponent(name)}`));
});

test('an existing group is adopted by name, not duplicated', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const name = groupName(DEFAULT_APP_ID);
  // Substring match — the worker must pick the exact name, not groups[0].
  groupsResponse = () => jsonResponse(200, { groups: [{ id: 'other', name: `${name}-old` }, { id: GROUP_ID, name }] });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(lastPinataInit.body).group_id, GROUP_ID);
  assert.equal(groupCalls.length, 1); // looked up, never created
});

test('the wallet→group id is cached in KV across mints', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ RATE_KV: kv });
  const p = await proof();
  await call(env, { body: p });
  const afterFirst = groupCalls.length;
  await call(env, { body: p });
  assert.equal(kv._store.get(`group:${groupName(DEFAULT_APP_ID)}`), GROUP_ID);
  assert.equal(groupCalls.length, afterFirst); // second mint hit the cache
});

test('missing PINATA_GROUP_PREFIX → 502 and never mints', async () => {
  rpcResponse = registeredRpc; // pinataResponse null: a mint would throw
  const env = baseEnv();
  delete env.PINATA_GROUP_PREFIX;
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 502);
  assert.equal(groupCalls.length, 0);
});

test('GET with proof in query params → 200', async () => {
  pinataResponse = pinataOk;
  const res = await call(baseEnv({ STUB_REGISTRATION_CHECK: 'true' }), { method: 'GET', query: await proof() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
});

/* ── failure modes ───────────────────────────────────────────────────────── */

test('unsupported method → 405', async () => {
  const res = await call(baseEnv(), { method: 'PUT' });
  assert.equal(res.status, 405);
});

test('gate contracts come from the SDK, with no address configured', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  // The `to` of each eth_call IS the deployment gated on. Asserting it against the
  // SDK is what catches the worker sitting on a stale registry while the SDK has
  // moved on.
  const [status] = callsTo(SELECTOR.publisherStatus);
  assert.equal(status.params[0].to.toLowerCase(), FangornConfig.dataRegistryContractAddress.toLowerCase());
  const [access] = callsTo(SELECTOR.access);
  assert.equal(access.params[0].to.toLowerCase(), FangornConfig.appRegistryContractAddress.toLowerCase());
});

test('invalid address → 400', async () => {
  const res = await call(baseEnv(), { body: { address: 'not-an-address' } });
  assert.equal(res.status, 400);
});

test('missing address → 400', async () => {
  const res = await call(baseEnv(), { body: {} });
  assert.equal(res.status, 400);
});

test('no signature yet → 401 with challenge to sign', async () => {
  const res = await call(baseEnv(), { body: { address: ACCOUNT.address } });
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /Sign the .challenge. message/);
  assert.match(res.json.challenge, /Fangorn onchain-gate access request/);
});

test('signature from the wrong key → 401 verification failed', async () => {
  // Message claims ACCOUNT's address, but OTHER signed it → recovered ≠ address.
  const message = challengeMessage(ACCOUNT.address, nowSec());
  const signature = await OTHER.signMessage({ message });
  const res = await call(baseEnv(), { body: { address: ACCOUNT.address, message, signature } });
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

test('address not registered → 403', async () => {
  rpcResponse = appRpc({ publisherStatus: 0 });
  const res = await call(baseEnv({ REGISTER_URL: 'https://fangorn.network' }), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /not registered/);
});

test('publisher suspended network-wide → 403 that says so, not "register"', async () => {
  rpcResponse = appRpc({ publisherStatus: 2 }); // pinataResponse null: a mint would throw
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /suspended from publishing/i);
  assert.doesNotMatch(res.json.error, /register/i);
});

test('RPC failure → 502', async () => {
  rpcResponse = () => jsonResponse(500, { error: 'rpc down' });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /access check failed/i);
});

test('Pinata sign failure → 502', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = () => jsonResponse(500, { error: 'nope' });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Failed to create Pinata upload URL/);
});

test('missing PINATA_JWT → 502', async () => {
  rpcResponse = registeredRpc; // JWT check happens after registration passes
  const env = baseEnv();
  delete env.PINATA_JWT;
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Failed to create Pinata upload URL/);
});

/* ── per-app byte budget ─────────────────────────────────────────────────── */

test('declared size under budget → 200, URL scoped to size, debits bytes', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(DEFAULT_APP_ID)]: 1000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.maxFileSize, 4000 + 4096);              // requested + headroom
  assert.equal(kv._store.get(usageKey(DEFAULT_APP_ID)), '5000');       // 1000 + declared 4000
});

test('requested size over the per-upload ceiling → 413 (no mint)', async () => {
  rpcResponse = registeredRpc; // pinataResponse null: a mint would throw
  const env = baseEnv({ MAX_UPLOAD_SIZE: '5000' });
  const res = await call(env, { body: { ...(await proof()), size: 6000 } });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /per-upload maximum/i);
});

test('declared size over remaining budget → 429 and never mints', async () => {
  rpcResponse = registeredRpc; // pinataResponse null: a mint would throw
  const kv = mockKV({ [usageKey(DEFAULT_APP_ID)]: 9000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 429);
  assert.match(res.json.error, /budget reached/i);
  assert.equal(kv._store.get(usageKey(DEFAULT_APP_ID)), '9000'); // unchanged — no grant
});

test('failed mint does not consume budget', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = () => jsonResponse(500, { error: 'nope' });
  const kv = mockKV({ [usageKey(DEFAULT_APP_ID)]: 100 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 502);
  assert.equal(kv._store.get(usageKey(DEFAULT_APP_ID)), '100'); // no grant, no charge
});

test('retry with same uploadId re-mints but is charged once', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(DEFAULT_APP_ID)]: 1000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const body = { ...(await proof()), size: 3000, uploadId: 'up-1' };
  const first = await call(env, { body });
  const second = await call(env, { body }); // same uploadId = a retry
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);       // re-mints a fresh URL
  assert.equal(kv._store.get(usageKey(DEFAULT_APP_ID)), '4000'); // 1000 + 3000 once, not twice
});

test('reusing an uploadId for a larger size is charged the larger size', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(DEFAULT_APP_ID)]: 0 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const p = await proof();
  await call(env, { body: { ...p, size: 2000, uploadId: 'up-2' } }); // pays 2000
  await call(env, { body: { ...p, size: 5000, uploadId: 'up-2' } }); // larger → charged
  assert.equal(kv._store.get(usageKey(DEFAULT_APP_ID)), '7000'); // 2000 + 5000
});

/* ── the app's subscription ──────────────────────────────────────────────── */

test('lapsed or never-paid app → 402 on the first byte, naming the owner (never mints)', async () => {
  // paidAt 0 cannot happen for a claimed app (claiming pays), but pins the guard.
  for (const paidAt of [nowSec() - 40 * 86400, 0]) {
    rpcResponse = appRpc({ paidAt }); // pinataResponse null: a mint would throw
    const kv = mockKV();
    const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', RATE_KV: kv });
    const res = await call(env, { body: { ...(await proof()), size: 1, appId: APP_ID } });
    assert.equal(res.status, 402);
    assert.match(res.json.error, new RegExp(`app ${APP_ID} is inactive`));
    assert.match(res.json.error, new RegExp(OWNER.address, 'i'));
    assert.match(res.json.error, /fangorn\.network\/subscribe/); // default SUBSCRIBE_URL
    assert.equal(kv._store.size, 0); // no grant, no charge
    assert.equal(groupCalls.length, 0);
  }
});

test('SUBSCRIPTION_WINDOW_DAYS sets how long a payment lasts', async () => {
  rpcResponse = appRpc({ paidAt: nowSec() - 40 * 86400 });
  pinataResponse = pinataOk;
  const res = await call(baseEnv({ SUBSCRIPTION_WINDOW_DAYS: '60' }), { body: await proof() });
  assert.equal(res.status, 200);
});

/* ── app membership (every request) ──────────────────────────────────────── */

test('no appId → the default app is checked, and billed', async () => {
  rpcResponse = appRpc();
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000 } });
  assert.equal(res.status, 200);
  // access(defaultApp, caller): selector, then the two argument words.
  const [access] = callsTo(SELECTOR.access);
  assert.equal(
    access.params[0].data,
    SELECTOR.access + DEFAULT_APP_ID.slice(2) + ACCOUNT.address.slice(2).toLowerCase().padStart(64, '0'),
  );
  assert.equal(kv._store.get(usageKey(DEFAULT_APP_ID)), '4000');
});

test('never added by the app owner → 403 saying to ask them (never mints)', async () => {
  // Globally registered, but not a publisher of the app — default or named.
  for (const [body, appId] of [[{}, DEFAULT_APP_ID], [{ appId: APP_ID }, APP_ID]]) {
    rpcResponse = appRpc({ member: false }); // pinataResponse null: a mint would throw
    const res = await call(baseEnv(), { body: { ...(await proof()), ...body } });
    assert.equal(res.status, 403);
    assert.match(res.json.error, new RegExp(`not a publisher of app ${appId}`));
    assert.match(res.json.error, /owner to add/);
    assert.equal(groupCalls.length, 0);
  }
});

test('added but terms not accepted yet → 403 asking them to join', async () => {
  rpcResponse = appRpc({ member: false, status: 3 });
  const res = await call(baseEnv(), { body: { ...(await proof()), appId: APP_ID } });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /has not accepted its terms yet/);
  assert.equal(groupCalls.length, 0);
});

test('suspended app → 403 that names the suspension (never mints)', async () => {
  // Memberships survive an app takedown, so the caller is still ACTIVE underneath.
  rpcResponse = appRpc({ member: false, appSuspended: true, status: 1 });
  const res = await call(baseEnv(), { body: { ...(await proof()), appId: APP_ID } });
  assert.equal(res.status, 403);
  assert.match(res.json.error, new RegExp(`App ${APP_ID} is suspended`));
  assert.equal(groupCalls.length, 0);
});

test('publisher suspended from the app → 403 that names the suspension (never mints)', async () => {
  rpcResponse = appRpc({ member: false, status: 2 });
  const res = await call(baseEnv(), { body: { ...(await proof()), appId: APP_ID } });
  assert.equal(res.status, 403);
  assert.match(res.json.error, new RegExp(`suspended from app ${APP_ID}`));
  assert.equal(groupCalls.length, 0);
});

test('member on stale terms → 403 asking them to re-accept', async () => {
  rpcResponse = appRpc({ member: false, status: 1 });
  const res = await call(baseEnv(), { body: { ...(await proof()), appId: APP_ID } });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /has not accepted the current terms/);
});

test('RPC failure on the app read → 502 (never mints)', async () => {
  const ok = appRpc();
  rpcResponse = (url, init) =>
    JSON.parse(init.body).params[0].data.startsWith(SELECTOR.access)
      ? jsonResponse(500, { error: 'rpc down' })
      : ok(url, init);
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /access check failed/i);
});

/* ── app-scoped uploads ──────────────────────────────────────────────────── */

test('appId → group is <prefix>:<appId>:<wallet>, and bytes bill that app', async () => {
  rpcResponse = appRpc();
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000, appId: APP_ID } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(groupCalls.at(-1).init.body).name, groupName(APP_ID));
  // The named app's counter moved; the default app's did not.
  assert.equal(kv._store.get(usageKey(APP_ID)), '4000');
  assert.equal(kv._store.get(usageKey(DEFAULT_APP_ID)), undefined);
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

test('unclaimed app (owner 0x0) → 403, never billed', async () => {
  // member: false is what the chain reports (nobody can join an app nobody owns);
  // member: true cannot happen on-chain and pins the guard behind it.
  for (const member of [false, true]) {
    rpcResponse = appRpc({ member, owner: '0x' + '0'.repeat(40) });
    const kv = mockKV();
    const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', RATE_KV: kv });
    const res = await call(env, { body: { ...(await proof()), appId: APP_ID } });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /no owner on-chain/i);
    assert.equal(kv._store.size, 0);
  }
});

test('malformed appId → 400 before any chain call', async () => {
  const res = await call(baseEnv(), { body: { ...(await proof()), appId: '0xdeadbeef' } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /32-byte hex/);
});

/* ── usage endpoint ──────────────────────────────────────────────────────── */

test('GET /usage → an app\'s byte counter + limit (no proof, no RPC)', async () => {
  // rpcResponse/pinataResponse stay null: /usage must hit neither.
  const kv = mockKV({ [usageKey(APP_ID)]: 200, [usageKey(DEFAULT_APP_ID)]: 7 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '5000', RATE_KV: kv });
  const res = await worker.fetch(new Request(`https://worker.test/usage?appId=${APP_ID}`), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.appId, APP_ID);
  assert.equal(body.daily, 200);
  assert.equal(body.dailyLimit, 5000);

  // No appId → the default app, the same fallback a mint applies.
  const fallback = await (await worker.fetch(new Request('https://worker.test/usage'), env)).json();
  assert.equal(fallback.appId, DEFAULT_APP_ID);
  assert.equal(fallback.daily, 7);
});

test('GET /usage with a bad appId → 400', async () => {
  const res = await worker.fetch(new Request('https://worker.test/usage?appId=nope'), baseEnv());
  assert.equal(res.status, 400);
});
