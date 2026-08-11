/**
 * Tests for the quickbeam-registry worker — one case per success/failure mode.
 *
 * The worker is a plain `(request, env) => Response` over standard Web APIs, so we
 * call it directly (no miniflare) with an in-memory KV stub and stubbed RPC/instance
 * fetches. Ownership signatures are real EIP-191 personal_signs via viem, the same
 * lib the worker uses to recover them.
 *
 * Run:  node --test   (from quickbeam-registry/)
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import worker from '../src/index.js';

/* ── stubs ───────────────────────────────────────────────────────────────── */

const realFetch = globalThis.fetch;
let rpcResponse = null;      // eth_call result for access(address)
let instanceResponse = null; // whatever the box returns
let lastInstanceUrl = null;
let runCalls = [];           // Cloud Run Admin API calls, in order

before(() => {
  globalThis.fetch = async (url, init) => {
    const href = typeof url === 'string' ? url : url.url;
    if (href.startsWith('http://box')) {
      lastInstanceUrl = href;
      if (!instanceResponse) throw new Error(`unexpected instance call: ${href}`);
      return instanceResponse(href, init);
    }
    if (href.startsWith('https://oauth2.googleapis.com')) {
      return jsonResponse({ access_token: 'tok', expires_in: 3600 });
    }
    if (href.startsWith('https://run.googleapis.com')) {
      runCalls.push({ href, method: init?.method || 'GET', body: init?.body });
      if (init?.method === 'DELETE') return jsonResponse({});
      if (href.endsWith(':setIamPolicy')) return jsonResponse({});
      if (init?.method === 'POST') return jsonResponse({ name: 'op' });
      return jsonResponse({ uri: 'https://qb-mcp-abc.run.app' }); // GET → ready
    }
    if (!rpcResponse) throw new Error(`unexpected RPC call: ${href}`);
    return rpcResponse(href, init);
  };
});
after(() => { globalThis.fetch = realFetch; });

const jsonResponse = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });

// A throwaway PKCS#8 RSA key so the JWT signing path runs for real rather than
// being stubbed — importKey/sign is where a bad PEM would blow up.
const TEST_SA_KEY = await (async () => {
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const der = await subtle.exportKey('pkcs8', pair.privateKey);
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
})();

const withGcp = (env) => Object.assign(env, {
  GCP_PROJECT: 'p', GCP_REGION: 'us-central1', GCP_SA_EMAIL: 'sa@p.iam.gserviceaccount.com',
  GCP_SA_KEY: TEST_SA_KEY, QUICKBEAM_IMAGE: 'us-docker.pkg.dev/p/qb/quickbeam:latest',
});

/** Minimal Workers KV: get/put/delete/list over a Map. */
function kvStub() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) {
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

/** An access() return: two 32-byte words, (bool registered, uint64 paidAt). */
function accessResult(registered, paidAt) {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  return { ok: true, json: async () => ({ result: '0x' + word(registered ? 1 : 0) + word(paidAt) }) };
}

const ADMIN_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const A_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba';
const B_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const admin = privateKeyToAccount(ADMIN_KEY);
const alice = privateKeyToAccount(A_KEY);
const bob = privateKeyToAccount(B_KEY);

const PUB = '0x147c24c5Ea2f1EE1ac42AD16820De23bBba45Ef6';
const PUB2 = '0x9dFA1680e682e0Fc79c5904ab453c04c7252572c';
const src = (owner, namespace) => ({ owner, namespace });

let env;
beforeEach(() => {
  env = {
    REGISTRY_KV: kvStub(),
    SUBSCRIPTION_CONTRACT_ADDRESS: '0xa554a1817a4ec6f2808e55ded21abc707d86b1b9',
    ADMIN_WALLETS: admin.address,
    SEARCH_URL: 'http://box:8080',
    CDN_URL: 'http://box:8090',
  };
  rpcResponse = () => accessResult(true, Math.floor(Date.now() / 1000)); // subscribed
  instanceResponse = null;
  lastInstanceUrl = null;
  runCalls = [];
});

/* ── helpers ─────────────────────────────────────────────────────────────── */

const post = (path, body) =>
  worker.fetch(new Request(`https://reg.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);

const get = (path) => worker.fetch(new Request(`https://reg.test${path}`), env);

/** Full handshake: ask for the challenge, sign it, resend. */
async function signedPost(path, account, extra = {}) {
  const first = await post(path, { address: account.address, ...extra });
  const { challenge } = await first.json();
  assert.ok(challenge, 'expected a challenge to sign');
  const signature = await account.signMessage({ message: challenge });
  return post(path, { address: account.address, message: challenge, signature, ...extra });
}

const createView = (account, name, sources) =>
  signedPost('/views', account, { name, sources });

/** View rows only — each view also writes a dns: reverse-map key. */
const viewCount = () => [...env.REGISTRY_KV.store.keys()].filter((k) => k.startsWith('view:')).length;

/* ── tests ───────────────────────────────────────────────────────────────── */

test('unsigned /views returns a challenge, not a view', async () => {
  const res = await post('/views', { address: alice.address, name: 'v', sources: [src(PUB, 'ns')] });
  assert.equal(res.status, 401);
  assert.match((await res.json()).challenge, /Quickbeam request/);
  assert.equal(env.REGISTRY_KV.store.size, 0);
});

test('a signature from the wrong wallet is rejected', async () => {
  const first = await post('/views', { address: alice.address, name: 'v', sources: [src(PUB, 'ns')] });
  const { challenge } = await first.json();
  const signature = await bob.signMessage({ message: challenge }); // wrong signer
  const res = await post('/views', {
    address: alice.address, message: challenge, signature, name: 'v', sources: [src(PUB, 'ns')],
  });
  assert.equal(res.status, 401);
  assert.equal(env.REGISTRY_KV.store.size, 0);
});

test('a stale Issued-At is rejected', async () => {
  const stale = [
    'Fangorn Quickbeam request', '',
    'I am proving that I control the wallet address below so Quickbeam can create or',
    'remove a search view on my behalf. This signature moves no funds.', '',
    `Address: ${alice.address.toLowerCase()}`,
    `Issued-At: ${Math.floor(Date.now() / 1000) - 4000}`,
  ].join('\n');
  const signature = await alice.signMessage({ message: stale });
  const res = await post('/views', {
    address: alice.address, message: stale, signature, name: 'v', sources: [src(PUB, 'ns')],
  });
  assert.equal(res.status, 401);
});

test('creating a view returns its search and MCP URLs', async () => {
  const res = await createView(alice, 'music', [src(PUB, 'tracks')]);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.match(body.id, /^qb_[0-9a-f]{8}_music$/);
  assert.match(body.searchUrl, /\/q\/qb_[0-9a-f]{8}_music\/search$/);
  assert.match(body.mcpCommand, /^quickbeam mcp --cdn-url https:\/\/reg\.test\/q\//);
});

test('EMBED ONCE: two requesters, same namespace → one watchlist entry', async () => {
  await createView(alice, 'mine', [src(PUB, 'shared')]);
  await createView(bob, 'theirs', [src(PUB, 'shared')]);

  const { sources } = await (await get('/watchlist')).json();
  assert.equal(sources.length, 1, 'the namespace must be embedded once, not per requester');
  assert.deepEqual(sources[0], { owner: PUB.toLowerCase(), namespace: 'shared' });
});

test('removing one view keeps the source for the other; removing the last drops it', async () => {
  const a = await (await createView(alice, 'mine', [src(PUB, 'shared')])).json();
  const b = await (await createView(bob, 'theirs', [src(PUB, 'shared')])).json();

  await signedPost('/admin/remove', admin, { id: a.id });
  let list = await (await get('/watchlist')).json();
  assert.equal(list.sources.length, 1, 'still wanted by the other view');

  await signedPost('/admin/remove', admin, { id: b.id });
  list = await (await get('/watchlist')).json();
  assert.equal(list.sources.length, 0, 'last reference gone → stop embedding');
});

test('a view spanning two namespaces puts both on the watchlist', async () => {
  await createView(alice, 'composed', [src(PUB, 'a'), src(PUB2, 'b')]);
  const { sources } = await (await get('/watchlist')).json();
  assert.equal(sources.length, 2);
});

test('two requesters may use the same view name', async () => {
  const a = await (await createView(alice, 'music', [src(PUB, 'x')])).json();
  const b = await (await createView(bob, 'music', [src(PUB, 'y')])).json();
  assert.notEqual(a.id, b.id);
  assert.equal(viewCount(), 2);
});

test('re-creating a view replaces it and keeps createdAt', async () => {
  const first = await (await createView(alice, 'music', [src(PUB, 'x')])).json();
  const again = await createView(alice, 'music', [src(PUB, 'x'), src(PUB, 'y')]);
  assert.equal(again.status, 200); // 200 not 202 — replace
  const body = await again.json();
  assert.equal(body.createdAt, first.createdAt);
  assert.equal(body.sources.length, 2);
  assert.equal(viewCount(), 1);
});

test('an unregistered wallet is told to register (403)', async () => {
  rpcResponse = () => accessResult(false, 0);
  const res = await createView(alice, 'v', [src(PUB, 'ns')]);
  assert.equal(res.status, 403);
  assert.equal(env.REGISTRY_KV.store.size, 0);
});

test('a lapsed subscription is told to subscribe (402)', async () => {
  rpcResponse = () => accessResult(true, Math.floor(Date.now() / 1000) - 40 * 86400);
  const res = await createView(alice, 'v', [src(PUB, 'ns')]);
  assert.equal(res.status, 402);
  assert.match((await res.json()).error, /active subscription/);
});

test('a malformed source is refused before it reaches KV', async () => {
  const bad = await createView(alice, 'v', [{ owner: 'nope', namespace: 'ns' }]);
  assert.equal(bad.status, 400);
  const worse = await createView(alice, 'v', [src(PUB, '../etc/passwd')]);
  assert.equal(worse.status, 400);
  assert.equal(env.REGISTRY_KV.store.size, 0);
});

test('a view with no sources is refused', async () => {
  const res = await createView(alice, 'v', []);
  assert.equal(res.status, 400);
});

test('the per-wallet cap holds', async () => {
  env.MAX_VIEWS_PER_WALLET = '1';
  await createView(alice, 'one', [src(PUB, 'a')]);
  const res = await createView(alice, 'two', [src(PUB, 'b')]);
  assert.equal(res.status, 429);
});

test('search is scoped to the view, and a caller cannot widen it', async () => {
  const v = await (await createView(alice, 'mine', [src(PUB, 'a')])).json();
  instanceResponse = () => new Response(JSON.stringify({ results: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });

  // The caller tries to reach a namespace the view does not cover.
  const res = await get(`/q/${v.id}/search?q=hi&scope=0xdead:secret&owner=0xdead`);
  assert.equal(res.status, 200);

  const url = new URL(lastInstanceUrl);
  assert.deepEqual(url.searchParams.getAll('scope'), [`${PUB.toLowerCase()}:a`]);
  assert.equal(url.searchParams.get('owner'), null);
  assert.equal(url.searchParams.get('q'), 'hi');
});

test('the MCP catalog lists only the view domains', async () => {
  const v = await (await createView(alice, 'mine', [src(PUB, 'a')])).json();
  instanceResponse = () => new Response(JSON.stringify({
    collection: 'fangorn',
    domains: [
      { name: '147c24c5-a', count: 10 },   // this view's
      { name: '147c24c5-b', count: 10 },   // same publisher, different namespace
      { name: '9dfa1680-a', count: 10 },   // different publisher, same namespace
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  const body = await (await get(`/q/${v.id}/cdn/catalog`)).json();
  assert.deepEqual(body.domains.map((d) => d.name), ['147c24c5-a']);
});

test('cdn passthrough strips the /cdn prefix (the path MCP pulls shards from)', async () => {
  const v = await (await createView(alice, 'mine', [src(PUB, 'a')])).json();
  instanceResponse = () => new Response('{}', { status: 200 });
  await get(`/q/${v.id}/cdn/domains/147c24c5-a/manifest`);
  assert.equal(lastInstanceUrl, 'http://box:8090/domains/147c24c5-a/manifest');
});

test('an unrecognised proxy path is 404 rather than forwarded somewhere', async () => {
  const v = await (await createView(alice, 'mine', [src(PUB, 'a')])).json();
  const res = await get(`/q/${v.id}/admin/secrets`);
  assert.equal(res.status, 404);
});

test('an unknown view id is 404, not a pass-through', async () => {
  const res = await get('/q/qb_deadbeef_nope/search?q=x');
  assert.equal(res.status, 404);
});

test('proxy reports an unreachable instance as 502, not a crash', async () => {
  const v = await (await createView(alice, 'mine', [src(PUB, 'a')])).json();
  instanceResponse = () => { throw new Error('ECONNREFUSED'); };
  const res = await get(`/q/${v.id}/search?q=x`);
  assert.equal(res.status, 502);
});

test('views are readable without a signature', async () => {
  const v = await (await createView(alice, 'mine', [src(PUB, 'a')])).json();
  assert.equal((await (await get(`/views/${v.id}`)).json()).id, v.id);
  const mine = await (await get(`/views?requester=${alice.address}`)).json();
  assert.equal(mine.views.length, 1);
  const theirs = await (await get(`/views?requester=${bob.address}`)).json();
  assert.equal(theirs.views.length, 0);
});

test('teardown is admin-only', async () => {
  const v = await (await createView(alice, 'mine', [src(PUB, 'a')])).json();
  const denied = await signedPost('/admin/remove', alice, { id: v.id });
  assert.equal(denied.status, 403);
  assert.equal(viewCount(), 1);

  const ok = await signedPost('/admin/remove', admin, { id: v.id });
  assert.equal(ok.status, 200);
  assert.equal(viewCount(), 0);
});

test('STUB_GATE skips the chain call entirely', async () => {
  env.STUB_GATE = 'true';
  rpcResponse = () => { throw new Error('RPC must not be called when stubbed'); };
  const res = await createView(alice, 'v', [src(PUB, 'ns')]);
  assert.equal(res.status, 202);
});

/* ── hosted MCP + per-view subdomain ─────────────────────────────────────── */

test('hostedMcp creates a Cloud Run service pointed at the view catalog', async () => {
  withGcp(env);
  const v = await (await signedPost('/views', alice, {
    name: 'music', sources: [src(PUB, 'a')], hostedMcp: true,
  })).json();

  const create = runCalls.find((c) => c.method === 'POST' && c.href.includes('serviceId='));
  assert.ok(create, 'expected a Cloud Run create');
  assert.match(create.href, /serviceId=qb-[0-9a-f]{8}-music/);

  const body = JSON.parse(create.body);
  const args = body.template.containers[0].args;
  assert.ok(args.includes('mcp'));
  assert.ok(args.some((a) => a.startsWith('--cdn-url=') && a.endsWith('/cdn')),
    `--cdn-url should point at this view's catalog, got ${args}`);
  assert.equal(body.template.scaling.minInstanceCount, 0, 'must scale to zero when idle');

  assert.ok(runCalls.some((c) => c.href.endsWith(':setIamPolicy')), 'must be publicly invokable');
  assert.equal(v.mcp.url, 'https://qb-mcp-abc.run.app');
});

test('no checkbox means no Cloud Run call at all', async () => {
  withGcp(env);
  await createView(alice, 'music', [src(PUB, 'a')]);
  assert.deepEqual(runCalls, []);
});

test('unchecking it on a replace deletes the service', async () => {
  withGcp(env);
  await signedPost('/views', alice, { name: 'm', sources: [src(PUB, 'a')], hostedMcp: true });
  runCalls = [];
  const again = await (await signedPost('/views', alice, {
    name: 'm', sources: [src(PUB, 'a')], hostedMcp: false,
  })).json();
  assert.ok(runCalls.some((c) => c.method === 'DELETE'));
  assert.equal(again.mcp, null);
});

test('removing a view deletes its hosted MCP', async () => {
  withGcp(env);
  const v = await (await signedPost('/views', alice, {
    name: 'm', sources: [src(PUB, 'a')], hostedMcp: true,
  })).json();
  runCalls = [];
  await signedPost('/admin/remove', admin, { id: v.id });
  assert.ok(runCalls.some((c) => c.method === 'DELETE'), 'the Cloud Run service must go too');
  assert.equal(viewCount(), 0);
});

test('hostedMcp without GCP configured fails loudly but keeps the view', async () => {
  const res = await signedPost('/views', alice, {
    name: 'm', sources: [src(PUB, 'a')], hostedMcp: true,
  });
  const body = await res.json();
  assert.match(body.mcpError, /not configured/);
  assert.equal(body.hostedMcp, false);
  assert.ok(body.searchUrl, 'search still works without a hosted MCP');
});

test('a per-view subdomain resolves the same view as /q/{id}', async () => {
  env.VIEW_DOMAIN_SUFFIX = 'qb.sond3r.com';
  const v = await (await createView(alice, 'music', [src(PUB, 'a')])).json();
  assert.match(v.searchUrl, /^https:\/\/qb-[0-9a-f]{8}-music\.qb\.sond3r\.com\/search$/);

  instanceResponse = () => new Response(JSON.stringify({ results: [] }), { status: 200 });
  const label = new URL(v.searchUrl).hostname.split('.')[0];
  const res = await worker.fetch(
    new Request(`https://${label}.qb.sond3r.com/search?q=hi`), env);
  assert.equal(res.status, 200);

  const forwarded = new URL(lastInstanceUrl);
  assert.equal(forwarded.pathname, '/search');
  assert.deepEqual(forwarded.searchParams.getAll('scope'), [`${PUB.toLowerCase()}:a`]);
});

test('an unknown subdomain is 404, not a proxy to nowhere', async () => {
  env.VIEW_DOMAIN_SUFFIX = 'qb.sond3r.com';
  const res = await worker.fetch(new Request('https://qb-dead-beef.qb.sond3r.com/search?q=x'), env);
  assert.equal(res.status, 404);
});
