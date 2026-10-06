/**
 * Tests for the pinata-url-provider worker — one case per success/failure mode.
 *
 * The worker is a plain `(request, env) => Response` over standard Web APIs, so
 * we call it directly (no miniflare) and stub the three outbound `fetch`es it
 * makes: the registry eth_calls (RPC — `access()` plus the AppRegistry views), the
 * Pinata groups API, and the Pinata `sign` endpoint. Ownership signatures are real EIP-191
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

// The SubscriptionRegistry `access(address)` view returns two 32-byte words:
// [0] bool registered, [1] uint64 paidAt (Unix seconds). This stub answers every
// eth_call with that shape, so word [0] doubles as the follow-up read: a registered
// wallet's isRegisteredForApp reads true, an unregistered one's status reads 0.
const accessRpc = ({ registered = true, paidAt = 0 } = {}) =>
  () => jsonResponse(200, { result: '0x' + wordHex(registered ? 1 : 0) + wordHex(paidAt) });
const registeredRpc = accessRpc({ registered: true });
const notRegisteredRpc = accessRpc({ registered: false });

/* ── request/proof helpers ───────────────────────────────────────────────── */
const BASE_URL = 'https://worker.test/';
const nowSec = () => Math.floor(Date.now() / 1000);

// Three throwaway deterministic keys (never use anywhere real). OWNER stands in
// for the app owner whose subscription pays for an app-scoped upload.
const ACCOUNT = privateKeyToAccount('0x' + '11'.repeat(32));
const OTHER = privateKeyToAccount('0x' + '22'.repeat(32));
const OWNER = privateKeyToAccount('0x' + '33'.repeat(32));

/* ── per-view eth_call stub ──────────────────────────────────────────────── */
// Routes eth_calls by selector, for tests that need the views to disagree: the
// caller's access(), AppRegistry.isRegisteredForApp(), getAppOwner() and the owner's
// access() for an app-scoped upload, plus the reads that explain a denial.
const APP_ID = '0x' + 'ab'.repeat(32);
const DEFAULT_APP_ID = toAppId(DEFAULT_APP);
const SELECTOR = {
  access: toFunctionSelector('access(address)'),
  member: toFunctionSelector('isRegisteredForApp(bytes32,address)'),
  owner: toFunctionSelector('getAppOwner(bytes32)'),
  appSuspended: toFunctionSelector('isAppSuspended(bytes32)'),
  status: toFunctionSelector('statusForApp(bytes32,address)'),
  publisherStatus: toFunctionSelector('getPublisherStatus(address)'),
};
const callsTo = (selector) => rpcCalls.filter((c) => c.params[0].data.startsWith(selector));

function appRpc({
  registered = true,
  publisherStatus = registered ? 1 : 0, // DataRegistry: 0 unregistered, 1 active, 2 suspended
  member = true,
  appSuspended = false,
  status = member ? 1 : 0,              // AppRegistry, same codes, per app
  owner = OWNER.address,
  ownerPaidAt = nowSec(),
} = {}) {
  return (_url, init) => {
    const data = JSON.parse(init.body).params[0].data;
    switch (data.slice(0, 10)) {
      case SELECTOR.member:
        return jsonResponse(200, { result: '0x' + wordHex(member ? 1 : 0) });
      case SELECTOR.owner:
        return jsonResponse(200, { result: '0x' + wordHex(BigInt(owner)) });
      case SELECTOR.appSuspended:
        return jsonResponse(200, { result: '0x' + wordHex(appSuspended ? 1 : 0) });
      case SELECTOR.status:
        return jsonResponse(200, { result: '0x' + wordHex(status) });
      case SELECTOR.publisherStatus:
        return jsonResponse(200, { result: '0x' + wordHex(publisherStatus) });
      case SELECTOR.access: {
        // access() is read for the caller (registration) and for the app owner
        // (paidAt) — tell them apart by the address argument.
        const arg = '0x' + data.slice(34, 74);
        const isOwner = arg.toLowerCase() === owner.toLowerCase();
        return jsonResponse(200, { result: '0x' + wordHex(registered ? 1 : 0) + wordHex(isOwner ? ownerPaidAt : 0) });
      }
      default:
        throw new Error(`unexpected eth_call selector ${data.slice(0, 10)}`);
    }
  };
}

function baseEnv(overrides = {}) {
  return {
    PINATA_JWT: 'test-jwt',
    PINATA_GROUP_PREFIX: 'testnet',
    STUB_REGISTRATION_CHECK: 'false',
    // No SUBSCRIPTION_CONTRACT_ADDRESS: the gate contract comes from the SDK now.
    // Tests that care about the override set it explicitly.
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
const usageKey = (account) => `bytes:${account.address.toLowerCase()}:${utcDay()}`;
const totalKey = (account) => `total:${account.address.toLowerCase()}`;

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

/* ── per-wallet Pinata group ─────────────────────────────────────────────── */

test('mint files the upload under a per-wallet group named <prefix>:<wallet>', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  // Signed into the upload URL, so the uploader can't file the pin elsewhere.
  assert.equal(JSON.parse(lastPinataInit.body).group_id, GROUP_ID);
  const name = `testnet:${ACCOUNT.address.toLowerCase()}`;
  assert.equal(JSON.parse(groupCalls.at(-1).init.body).name, name);
  assert.match(groupCalls[0].url, new RegExp(`name=${encodeURIComponent(name)}`));
});

test('an existing group is adopted by name, not duplicated', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const name = `testnet:${ACCOUNT.address.toLowerCase()}`;
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
  assert.equal(kv._store.get(`group:testnet:${ACCOUNT.address.toLowerCase()}`), GROUP_ID);
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
  // The `to` of the access() eth_call IS the deployment gated on. Asserting it
  // against the SDK is what would have caught the worker sitting on a stale
  // SubscriptionRegistry while the SDK had moved on.
  assert.equal(
    rpcCalls[0].params[0].to.toLowerCase(),
    FangornConfig.subscriptionRegistryContractAddress.toLowerCase(),
  );
  // Likewise the membership read, which goes to the AppRegistry.
  const [member] = callsTo(SELECTOR.member);
  assert.equal(member.params[0].to.toLowerCase(), FangornConfig.appRegistryContractAddress.toLowerCase());
});

test('SUBSCRIPTION_CONTRACT_ADDRESS overrides the SDK when set', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const override = '0x9a3811b365a4aeea1626eaad185b273424ae5e48';
  const res = await call(baseEnv({ SUBSCRIPTION_CONTRACT_ADDRESS: override }), { body: await proof() });
  assert.equal(res.status, 200);
  assert.equal(rpcCalls[0].params[0].to.toLowerCase(), override);
});

test('non-stubbed + unusable address → 502 (no silent fallback)', async () => {
  // The SDK always carries one, so the only way to reach the throw is an override
  // that is set but malformed. It must fail rather than quietly using the SDK's —
  // an operator who typo'd an emergency repoint has to hear about it.
  const res = await call(baseEnv({ SUBSCRIPTION_CONTRACT_ADDRESS: '0xnope' }), { body: await proof() });
  assert.equal(res.status, 502);
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
  rpcResponse = notRegisteredRpc;
  const res = await call(baseEnv({ REGISTER_URL: 'https://fangorn.network' }), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /not registered/);
});

test('publisher suspended network-wide → 403 that says so, not "register"', async () => {
  rpcResponse = appRpc({ registered: false, publisherStatus: 2 }); // pinataResponse null: a mint would throw
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

/* ── per-wallet byte budget ──────────────────────────────────────────────── */

test('declared size under budget → 200, URL scoped to size, debits bytes', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(ACCOUNT)]: 1000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.maxFileSize, 4000 + 4096);              // requested + headroom
  assert.equal(kv._store.get(usageKey(ACCOUNT)), '5000');       // 1000 + declared 4000
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
  const kv = mockKV({ [usageKey(ACCOUNT)]: 9000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 429);
  assert.match(res.json.error, /budget reached/i);
  assert.equal(kv._store.get(usageKey(ACCOUNT)), '9000'); // unchanged — no grant
});

test('failed mint does not consume budget', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = () => jsonResponse(500, { error: 'nope' });
  const kv = mockKV({ [usageKey(ACCOUNT)]: 100 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 502);
  assert.equal(kv._store.get(usageKey(ACCOUNT)), '100'); // no grant, no charge
});

test('retry with same uploadId re-mints but is charged once', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(ACCOUNT)]: 1000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const body = { ...(await proof()), size: 3000, uploadId: 'up-1' };
  const first = await call(env, { body });
  const second = await call(env, { body }); // same uploadId = a retry
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);       // re-mints a fresh URL
  assert.equal(kv._store.get(usageKey(ACCOUNT)), '4000'); // 1000 + 3000 once, not twice
});

test('reusing an uploadId for a larger size is charged the larger size', async () => {
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey(ACCOUNT)]: 0 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const p = await proof();
  await call(env, { body: { ...p, size: 2000, uploadId: 'up-2' } }); // pays 2000
  await call(env, { body: { ...p, size: 5000, uploadId: 'up-2' } }); // larger → charged
  assert.equal(kv._store.get(usageKey(ACCOUNT)), '7000'); // 2000 + 5000
});

/* ── free tier + on-chain subscription ───────────────────────────────────── */

test('under the free tier → 200, debits the lifetime counter, no window check', async () => {
  // access() returns registered=true, paidAt=0. Under the free tier the window
  // check is skipped, so paidAt=0 doesn't matter and the upload mints.
  rpcResponse = registeredRpc;
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000 } });
  assert.equal(res.status, 200);
  assert.equal(kv._store.get(totalKey(ACCOUNT)), '4000');
});

test('past the free tier with an active subscription → 200', async () => {
  rpcResponse = accessRpc({ registered: true, paidAt: nowSec() });
  pinataResponse = pinataOk;
  const kv = mockKV({ [totalKey(ACCOUNT)]: 9000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 200);
  assert.equal(kv._store.get(totalKey(ACCOUNT)), '11000'); // keeps climbing past the limit
});

test('past the free tier with no subscription → 402 (never mints)', async () => {
  rpcResponse = accessRpc({ registered: true, paidAt: 0 }); // never subscribed
  const kv = mockKV({ [totalKey(ACCOUNT)]: 9000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 402);
  assert.match(res.json.error, /sign up for a subscription/i);
  assert.match(res.json.error, /fangorn\.network\/subscribe/); // default SUBSCRIBE_URL
  assert.equal(kv._store.get(totalKey(ACCOUNT)), '9000'); // unchanged — no grant
});

test('past the free tier with a stale (>30d) subscription → 402', async () => {
  rpcResponse = accessRpc({ registered: true, paidAt: nowSec() - 40 * 86400 });
  const kv = mockKV({ [totalKey(ACCOUNT)]: 9000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 402);
});

test('a subscriber past the free tier is still bound by the daily cap → 429', async () => {
  rpcResponse = accessRpc({ registered: true, paidAt: nowSec() }); // active sub
  const kv = mockKV({ [totalKey(ACCOUNT)]: 20000, [usageKey(ACCOUNT)]: 4000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', DAILY_BYTE_LIMIT: '5000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 429);
  assert.match(res.json.error, /budget reached/i);
});

test('retry past the free tier (same uploadId) is charged once', async () => {
  rpcResponse = accessRpc({ registered: true, paidAt: nowSec() });
  pinataResponse = pinataOk;
  const kv = mockKV({ [totalKey(ACCOUNT)]: 9000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const body = { ...(await proof()), size: 2000, uploadId: 'sub-1' };
  const first = await call(env, { body });
  const second = await call(env, { body }); // same uploadId = a retry
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(kv._store.get(totalKey(ACCOUNT)), '11000'); // 9000 + 2000 once, not twice
});

/* ── app membership (every request) ──────────────────────────────────────── */

test('no appId → membership is checked against the default app, caller is billed', async () => {
  rpcResponse = appRpc();
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000 } });
  assert.equal(res.status, 200);
  // isRegisteredForApp(defaultApp, caller): selector, then the two argument words.
  const [member] = callsTo(SELECTOR.member);
  assert.equal(
    member.params[0].data,
    SELECTOR.member + DEFAULT_APP_ID.slice(2) + ACCOUNT.address.slice(2).toLowerCase().padStart(64, '0'),
  );
  // No appId named → nobody else pays, and the owner is never looked up.
  assert.equal(kv._store.get(totalKey(ACCOUNT)), '4000');
  assert.equal(callsTo(SELECTOR.owner).length, 0);
});

test('no appId + not a member of the default app → 403 (never mints)', async () => {
  rpcResponse = appRpc({ member: false }); // pinataResponse null: a mint would throw
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 403);
  assert.match(res.json.error, new RegExp(`not an active publisher for app ${DEFAULT_APP_ID}`));
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

test('RPC failure on the app check → 502 (never mints)', async () => {
  const ok = appRpc();
  rpcResponse = (url, init) =>
    JSON.parse(init.body).params[0].data.startsWith(SELECTOR.member)
      ? jsonResponse(500, { error: 'rpc down' })
      : ok(url, init);
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /app check failed/i);
});

/* ── app-level subscription ──────────────────────────────────────────────── */

test('appId → group is <prefix>:<appId>:<wallet>, and bytes bill the app owner', async () => {
  rpcResponse = appRpc();
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000, appId: APP_ID } });
  assert.equal(res.status, 200);
  const name = `testnet:${APP_ID}:${ACCOUNT.address.toLowerCase()}`;
  assert.equal(JSON.parse(groupCalls.at(-1).init.body).name, name);
  // The app owner's counter moved; the caller's did not.
  assert.equal(kv._store.get(totalKey(OWNER)), '4000');
  assert.equal(kv._store.get(totalKey(ACCOUNT)), undefined);
});

test('registered publisher who never joined the app → 403 (never mints)', async () => {
  rpcResponse = appRpc({ member: false }); // pinataResponse null: a mint would throw
  const res = await call(baseEnv(), { body: { ...(await proof()), appId: APP_ID } });
  assert.equal(res.status, 403);
  assert.match(res.json.error, /not an active publisher for app/i);
  assert.equal(groupCalls.length, 0);
});

test('app past the free tier with an active owner subscription → 200', async () => {
  rpcResponse = appRpc({ ownerPaidAt: nowSec() });
  pinataResponse = pinataOk;
  const kv = mockKV({ [totalKey(OWNER)]: 9000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000, appId: APP_ID } });
  assert.equal(res.status, 200);
  assert.equal(kv._store.get(totalKey(OWNER)), '11000');
});

test('app owner publishing to their own app is read once, and pays for it', async () => {
  rpcResponse = appRpc({ owner: ACCOUNT.address, ownerPaidAt: nowSec() });
  pinataResponse = pinataOk;
  const kv = mockKV({ [totalKey(ACCOUNT)]: 9000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000, appId: APP_ID } });
  assert.equal(res.status, 200);
  assert.equal(callsTo(SELECTOR.access).length, 1); // paidAt reused, not re-read
});

test('app past the free tier whose owner never subscribed → 402', async () => {
  rpcResponse = appRpc({ ownerPaidAt: 0 });
  const kv = mockKV({ [totalKey(OWNER)]: 9000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000, appId: APP_ID } });
  assert.equal(res.status, 402);
  assert.match(res.json.error, new RegExp(OWNER.address, 'i'));
  assert.equal(kv._store.get(totalKey(OWNER)), '9000');
});

test('app past the free tier with a stale (>30d) owner subscription → 402', async () => {
  rpcResponse = appRpc({ ownerPaidAt: nowSec() - 40 * 86400 });
  const kv = mockKV({ [totalKey(OWNER)]: 9000 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000, appId: APP_ID } });
  assert.equal(res.status, 402);
});

test('unclaimed app (owner 0x0) → 403, never billed to the zero address', async () => {
  // member: false is what the chain reports (nobody can join an app nobody owns);
  // member: true cannot happen on-chain and pins the billing guard behind it.
  for (const member of [false, true]) {
    rpcResponse = appRpc({ member, owner: '0x' + '0'.repeat(40) });
    const kv = mockKV();
    const env = baseEnv({ FREE_BYTE_LIMIT: '10000', RATE_KV: kv });
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

test('GET /usage → byte counters + limits (no proof, no RPC)', async () => {
  // rpcResponse/pinataResponse stay null: /usage must hit neither.
  const kv = mockKV({ [totalKey(ACCOUNT)]: 500, [usageKey(ACCOUNT)]: 200 });
  const env = baseEnv({ FREE_BYTE_LIMIT: '10000', DAILY_BYTE_LIMIT: '5000', RATE_KV: kv });
  const res = await worker.fetch(new Request(`https://worker.test/usage?address=${ACCOUNT.address}`), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.total, 500);
  assert.equal(body.freeLimit, 10000);
  assert.equal(body.daily, 200);
  assert.equal(body.dailyLimit, 5000);
});

test('GET /usage with a bad address → 400', async () => {
  const res = await worker.fetch(new Request('https://worker.test/usage?address=nope'), baseEnv());
  assert.equal(res.status, 400);
});
