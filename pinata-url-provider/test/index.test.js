/**
 * Tests for the pinata-url-provider worker — one case per success/failure mode.
 *
 * The worker is a plain `(request, env) => Response` over standard Web APIs, so
 * we call it directly (no miniflare) and stub its two outbound `fetch`es: the
 * Pinata groups API and the Pinata `sign` endpoint. Ownership signatures are real
 * EIP-191 personal_signs via viem, the same lib the worker uses to recover them.
 *
 * Run:  node --test   (from pinata-url-provider/)
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import worker from '../src/index.js';

/* ── outbound fetch stub ─────────────────────────────────────────────────── */
// Routes by URL: the Pinata sign endpoint → `pinataResponse`, the Pinata groups
// API → `groupsResponse`. Anything else throws, so tests catch stray calls.
const realFetch = globalThis.fetch;
let pinataResponse = null;
let groupsResponse = null;
let lastPinataInit = null; // request init captured from the Pinata sign call
let groupCalls = [];       // { url, init } per Pinata groups API call

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
    throw new Error(`unexpected fetch ${u}`);
  };
});
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => {
  pinataResponse = null;
  lastPinataInit = null;
  groupCalls = [];
  // Default: no existing group → the worker creates one.
  groupsResponse = (u, init) =>
    init?.method === 'POST'
      ? jsonResponse(200, { data: { id: GROUP_ID } })
      : jsonResponse(200, { data: { groups: [] } });
});

const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

const pinataOk = () => jsonResponse(200, { data: 'https://uploads.pinata.cloud/signed/xyz' });
const GROUP_ID = 'ad4bc3bf-8794-49e7-94ff-fea1ce745779';

/* ── request/proof helpers ───────────────────────────────────────────────── */
const BASE_URL = 'https://worker.test/';
const nowSec = () => Math.floor(Date.now() / 1000);

// Throwaway deterministic keys (never use anywhere real).
const ACCOUNT = privateKeyToAccount('0x' + '11'.repeat(32));
const OTHER = privateKeyToAccount('0x' + '22'.repeat(32));

function baseEnv(overrides = {}) {
  return {
    PINATA_JWT: 'test-jwt',
    PINATA_GROUP_PREFIX: 'testnet',
    ...overrides,
  };
}

// Mirror of the worker's canonical challenge template (see buildChallengeMessage).
function challengeMessage(address, issuedAt) {
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
const usageKey = (who = ACCOUNT.address.toLowerCase()) => `bytes:${who}:${utcDay()}`;
const groupName = (account = ACCOUNT, prefix = 'testnet') => `${prefix}:${account.address.toLowerCase().slice(2)}`.slice(0, 50);

/* ── success modes ───────────────────────────────────────────────────────── */

test('OPTIONS preflight → 204 with CORS headers', async () => {
  const res = await call(baseEnv(), { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('valid signature → 200 with uploadUrl', async () => {
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.uploadUrl, 'https://uploads.pinata.cloud/signed/xyz');
});

test('PINATA_ALLOW_MIME_TYPES → forwarded to Pinata as a trimmed allow_mime_types', async () => {
  pinataResponse = pinataOk;
  // Spaces after the comma also exercise the worker's per-entry .trim().
  const env = baseEnv({ PINATA_ALLOW_MIME_TYPES: 'application/octet-stream, text/plain' });
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 200);
  const payload = JSON.parse(lastPinataInit.body);
  assert.deepEqual(payload.allow_mime_types, ['application/octet-stream', 'text/plain']);
});

/* ── per-wallet Pinata group ────────────────────────────────────── */

test('mint files the upload under a group named <prefix>:<wallet>', async () => {
  pinataResponse = pinataOk;
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  // Signed into the upload URL, so the uploader can't file the pin elsewhere.
  assert.equal(JSON.parse(lastPinataInit.body).group_id, GROUP_ID);
  const name = groupName();
  assert.equal(JSON.parse(groupCalls.at(-1).init.body).name, name);
  assert.match(groupCalls[0].url, new RegExp(`name=${encodeURIComponent(name)}`));
});

test('a group name stays within Pinata\'s 50 characters', async () => {
  pinataResponse = pinataOk;
  const res = await call(baseEnv({ PINATA_GROUP_PREFIX: 'testnet-base' }), { body: await proof() });
  assert.equal(res.status, 200);
  const name = JSON.parse(groupCalls.at(-1).init.body).name;
  assert.equal(name, groupName(ACCOUNT, 'testnet-base'));
  assert.ok(name.length <= 50);
});

test('an existing group is adopted by name, not duplicated', async () => {
  pinataResponse = pinataOk;
  const name = groupName();
  // Substring match — the worker must pick the exact name, not groups[0].
  groupsResponse = () => jsonResponse(200, { data: { groups: [{ id: 'other', name: `${name}-old` }, { id: GROUP_ID, name }] } });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(lastPinataInit.body).group_id, GROUP_ID);
  assert.equal(groupCalls.length, 1); // looked up, never created
});

test('the wallet→group id is cached in KV across mints', async () => {
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ RATE_KV: kv });
  const p = await proof();
  await call(env, { body: p });
  const afterFirst = groupCalls.length;
  await call(env, { body: p });
  assert.equal(kv._store.get(`group:${groupName()}`), GROUP_ID);
  assert.equal(groupCalls.length, afterFirst); // second mint hit the cache
});

test('missing PINATA_GROUP_PREFIX → 502 and never mints', async () => {
  const env = baseEnv();
  delete env.PINATA_GROUP_PREFIX;
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 502);
  assert.equal(groupCalls.length, 0);
});

test('GET with proof in query params → 200', async () => {
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

test('invalid address → 400', async () => {
  const res = await call(baseEnv(), { body: { address: 'not-an-address' } });
  assert.equal(res.status, 400);
});

test('missing address → 400', async () => {
  const res = await call(baseEnv(), { body: {} });
  assert.equal(res.status, 400);
});

test('no signature yet → 401 with a challenge to sign', async () => {
  const res = await call(baseEnv(), { body: { address: ACCOUNT.address } });
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /Sign the .challenge. message/);
  assert.match(res.json.challenge, /Fangorn upload request/);
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

test('Pinata sign failure → 502', async () => {
  pinataResponse = () => jsonResponse(500, { error: 'nope' });
  const res = await call(baseEnv(), { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Failed to create Pinata upload URL/);
});

test('missing PINATA_JWT → 502', async () => {
  const env = baseEnv();
  delete env.PINATA_JWT;
  const res = await call(env, { body: await proof() });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /Failed to create Pinata upload URL/);
});

/* ── byte quota, retries ─────────────────────────────────────────────────── */

test('declared size under budget → 200, URL scoped to size, debits bytes', async () => {
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey()]: 1000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 4000 } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.maxFileSize, 4000 + 4096);              // requested + headroom
  assert.equal(kv._store.get(usageKey()), '5000');       // 1000 + declared 4000
});

test('requested size over the per-upload ceiling → 413 (no mint)', async () => {
  const env = baseEnv({ MAX_UPLOAD_SIZE: '5000' });
  const res = await call(env, { body: { ...(await proof()), size: 6000 } });
  assert.equal(res.status, 413);
  assert.match(res.json.error, /per-upload maximum/i);
});

test('declared size over remaining budget → 429 and never mints', async () => {
  const kv = mockKV({ [usageKey()]: 9000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 429);
  assert.match(res.json.error, /quota reached/i);
  assert.equal(kv._store.get(usageKey()), '9000'); // unchanged — no grant
});

test('failed mint does not consume budget', async () => {
  pinataResponse = () => jsonResponse(500, { error: 'nope' });
  const kv = mockKV({ [usageKey()]: 100 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 502);
  assert.equal(kv._store.get(usageKey()), '100'); // no grant, no charge
});

test('retry with same uploadId re-mints but is charged once', async () => {
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey()]: 1000 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const body = { ...(await proof()), size: 3000, uploadId: 'up-1' };
  const first = await call(env, { body });
  const second = await call(env, { body }); // same uploadId = a retry
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);       // re-mints a fresh URL
  assert.equal(kv._store.get(usageKey()), '4000'); // 1000 + 3000 once, not twice
});

test('reusing an uploadId for a larger size is charged the larger size', async () => {
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey()]: 0 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const p = await proof();
  await call(env, { body: { ...p, size: 2000, uploadId: 'up-2' } }); // pays 2000
  await call(env, { body: { ...p, size: 5000, uploadId: 'up-2' } }); // larger → charged
  assert.equal(kv._store.get(usageKey()), '7000'); // 2000 + 5000
});

/* ── per-publisher and global quotas ────────────────────────────────────── */

test('each publisher has its own daily quota', async () => {
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ DAILY_BYTE_LIMIT: '5000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const first = await call(env, { body: { ...(await proof(ACCOUNT)), size: 3000 } });
  const second = await call(env, { body: { ...(await proof(OTHER)), size: 3000 } });
  const again = await call(env, { body: { ...(await proof(ACCOUNT)), size: 3000 } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200); // another wallet, its own quota
  assert.equal(again.status, 429);
  assert.match(again.json.error, /quota reached/i);
  assert.equal(kv._store.get(usageKey()), '3000');
  assert.equal(kv._store.get(usageKey(OTHER.address.toLowerCase())), '3000');
});

test('the global quota caps every publisher together', async () => {
  pinataResponse = pinataOk;
  const kv = mockKV();
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', GLOBAL_DAILY_BYTE_LIMIT: '5000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const first = await call(env, { body: { ...(await proof(ACCOUNT)), size: 3000 } });
  const second = await call(env, { body: { ...(await proof(OTHER)), size: 3000 } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.match(second.json.error, /storage budget for today/);
  assert.equal(kv._store.get(usageKey('all')), '3000');
  assert.equal(kv._store.get(usageKey(OTHER.address.toLowerCase())), undefined);
});

test('the global quota works without a per-publisher one', async () => {
  pinataResponse = pinataOk;
  const kv = mockKV({ [usageKey('all')]: 4000 });
  const env = baseEnv({ GLOBAL_DAILY_BYTE_LIMIT: '5000', MAX_UPLOAD_SIZE: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 2000 } });
  assert.equal(res.status, 429);
});

/* ── denylist ────────────────────────────────────────────────────────────── */

test('a denied address → 403, never mints or charges', async () => {
  const kv = mockKV({ [`deny:${ACCOUNT.address.toLowerCase()}`]: 1 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '10000', RATE_KV: kv });
  const res = await call(env, { body: { ...(await proof()), size: 10 } });
  assert.equal(res.status, 403);
  assert.equal(groupCalls.length, 0);
  assert.equal(kv._store.get(usageKey()), undefined);

  pinataResponse = pinataOk;
  const other = await call(env, { body: { ...(await proof(OTHER)), size: 10 } });
  assert.equal(other.status, 200);
});

/* ── usage endpoint ──────────────────────────────────────────────────────── */

test('GET /usage → a publisher\'s byte counter + limit (no proof)', async () => {
  const kv = mockKV({ [usageKey()]: 200, [usageKey(OTHER.address.toLowerCase())]: 7 });
  const env = baseEnv({ DAILY_BYTE_LIMIT: '5000', RATE_KV: kv });
  const res = await worker.fetch(new Request(`https://worker.test/usage?address=${ACCOUNT.address}`), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.address, ACCOUNT.address.toLowerCase());
  assert.equal(body.daily, 200);
  assert.equal(body.dailyLimit, 5000);
});

test('GET /usage with a bad or missing address → 400', async () => {
  for (const q of ['?address=nope', '']) {
    const res = await worker.fetch(new Request(`https://worker.test/usage${q}`), baseEnv());
    assert.equal(res.status, 400);
  }
});
