/**
 * Tests for the pinata-url-provider worker — one case per success/failure mode.
 *
 * The worker is a plain `(request, env) => Response` over standard Web APIs, so
 * we call it directly (no miniflare) and stub the two outbound `fetch`es it
 * makes: the registry `eth_call` (RPC) and the Pinata `sign` endpoint. Ownership
 * signatures are real EIP-191 personal_signs via viem, the same lib the worker
 * uses to recover them.
 *
 * Run:  node --test   (from pinata-url-provider/)
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import worker from '../src/index.js';

/* ── outbound fetch stub ─────────────────────────────────────────────────── */
// Routes by URL: anything hitting Pinata → `pinataResponse`, else the RPC.
// A route left null that gets called throws, so tests catch stray calls.
const realFetch = globalThis.fetch;
let rpcResponse = null;
let pinataResponse = null;

before(() => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('uploads.pinata.cloud')) {
      if (!pinataResponse) throw new Error('unexpected Pinata fetch');
      return pinataResponse();
    }
    if (!rpcResponse) throw new Error('unexpected RPC fetch');
    return rpcResponse();
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { rpcResponse = null; pinataResponse = null; });

const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const abiWord = (n) => '0x' + String(n).padStart(64, '0');
const registeredRpc = () => jsonResponse(200, { result: abiWord(1) });
const notRegisteredRpc = () => jsonResponse(200, { result: abiWord(0) });
const pinataOk = () => jsonResponse(200, { data: 'https://uploads.pinata.cloud/signed/xyz' });

/* ── request/proof helpers ───────────────────────────────────────────────── */
const BASE_URL = 'https://worker.test/';
const nowSec = () => Math.floor(Date.now() / 1000);

// Two throwaway deterministic keys (never use anywhere real).
const ACCOUNT = privateKeyToAccount('0x' + '11'.repeat(32));
const OTHER = privateKeyToAccount('0x' + '22'.repeat(32));

function baseEnv(overrides = {}) {
  return {
    PINATA_JWT: 'test-jwt',
    STUB_REGISTRATION_CHECK: 'false',
    REGISTRY_CONTRACT_ADDRESS: '0x9a3811b365a4aeea1626eaad185b273424ae5e48',
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

test('non-stubbed + missing REGISTRY_CONTRACT_ADDRESS → 502 (no silent fallback)', async () => {
  const env = baseEnv();
  delete env.REGISTRY_CONTRACT_ADDRESS;
  const res = await call(env, { body: await proof() }); // throws before any RPC fetch
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

test('RPC failure → 502', async () => {
  rpcResponse = () => jsonResponse(500, { error: 'rpc down' });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /registration check failed/i);
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
