/**
 * quickbeam-registry — the control plane for Quickbeam.
 *
 * Two ideas, and the whole design falls out of keeping them apart:
 *
 *   EMBEDDING IS PER (owner, namespace) AND HAPPENS ONCE. The watch list this worker
 *   serves is the deduplicated UNION of every view's sources, so a second requester
 *   asking for an already-watched namespace costs one KV row and no embedding work.
 *
 *   ACCESS IS PER REQUESTER. A "view" is a named set of namespaces that gets its own
 *   search URL and its own MCP catalog. It is a FILTER over the shared collection,
 *   never a copy of the vectors.
 *
 * Deduplication needs no refcount: a namespace is watched while at least one view
 * references it, and drops off the union when the last one goes.
 *
 * There is no ownership check anywhere — you do not have to own a namespace to have
 * it embedded. And there is no access control on reads: the source graphs are public
 * on-chain data, so a view id is a convenience, not a secret. Writes are gated
 * (signature + active subscription) because creating a view is what spends embedding
 * work.
 *
 * Only dependency is `viem` (signature recovery + selector encoding).
 */

import { recoverMessageAddress, toFunctionSelector } from 'viem';
import {
  gcpConfigured, serviceName, createMcpService, getMcpService, deleteMcpService,
} from './gcp.js';

const DEFAULT_RPC_URL = 'https://sepolia-rollup.arbitrum.io/rpc';
const DEFAULT_ACCESS_FUNCTION = 'access(address)';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── Per-view subdomain ──────────────────────────────────────────────────
    // `qb-147c24c5-music.qb.sond3r.com/search?q=…` is the same request as
    // `/q/qb_147c24c5_music/search?q=…`. A wildcard route on the zone means this
    // costs no DNS call and no certificate per view — Cloudflare already holds both.
    const host = await resolveHostView(env, url);
    if (host.matched) {
      // Once the hostname is under the view domain the request is a view request,
      // full stop. Falling through to the apex API here would answer a bogus
      // subdomain with a confusing "provide a valid address" instead of "no view".
      if (!host.id) return json(404, { error: `No view for ${url.hostname}` }, cors);
      return proxy(request, env, url, cors, { id: host.id, path: trimLead(url.pathname) });
    }

    // ── Query proxy, scoped to a view ───────────────────────────────────────
    if (url.pathname.startsWith('/q/')) {
      return proxy(request, env, url, cors);
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'Method not allowed. Use GET or POST.' }, cors);
    }

    // ── What the instance embeds: the union of every view's sources ─────────
    if (url.pathname === '/watchlist') {
      const seen = new Map();
      for (const view of await listViews(env)) {
        for (const s of view.sources) seen.set(`${s.owner}:${s.namespace}`, s);
      }
      return json(200, { sources: [...seen.values()] }, cors);
    }

    // ── Views are public to read (no privacy requirement) ───────────────────
    if (url.pathname.startsWith('/views/') && request.method === 'GET') {
      const id = url.pathname.slice('/views/'.length);
      const view = await readView(env, id);
      if (!view) return json(404, { error: `No view ${id}` }, cors);
      return json(200, await withMcpStatus(env, withUrls(view, url, env)), cors);
    }
    if (url.pathname === '/views' && request.method === 'GET') {
      const requester = (url.searchParams.get('requester') || '').toLowerCase();
      const views = await listViews(env);
      return json(200, {
        views: (requester ? views.filter((v) => v.requester === requester) : views)
          .map((v) => withUrls(v, url, env)),
      }, cors);
    }

    // Everything below writes, so it needs a proven wallet.
    const input = await readInput(request);
    const address = (input.address || '').toLowerCase();
    if (!isAddress(address)) {
      return json(400, {
        error: 'Provide a valid EVM address via ?address=0x… or JSON body { "address": "0x…" }.',
      }, cors);
    }

    const ownership = await verifyCallerOwnsAddress(input, address, env);
    if (!ownership.ok) {
      return json(401, { ok: false, address, error: ownership.error, challenge: ownership.challenge }, cors);
    }

    // ── Founder-only teardown ───────────────────────────────────────────────
    if (url.pathname === '/admin/remove') {
      if (!isAdmin(env, address)) return json(403, { error: 'Not an admin wallet.' }, cors);
      const id = (input.id || '').trim();
      const view = await readView(env, id);
      if (!view) return json(404, { error: `No view ${id}` }, cors);

      // Delete the hosted MCP before the row, so a failure here leaves the view
      // visible rather than orphaning a Cloud Run service nothing points at.
      let mcpError = null;
      if (view.mcp) {
        try {
          await deleteMcpService(env, id);
        } catch (err) {
          mcpError = err.message;
        }
      }
      await env.REGISTRY_KV.delete(viewKey(id));
      await env.REGISTRY_KV.delete(dnsKey(dnsLabel(id)));
      return json(mcpError ? 207 : 200, { ok: !mcpError, removed: id, ...(mcpError ? { mcpError } : {}) }, cors);
    }

    // ── Create or replace a view ────────────────────────────────────────────
    if (url.pathname === '/views') {
      const name = (input.name || '').trim();
      if (!isSafeName(name)) {
        return json(400, {
          error: 'Name must be 1-48 chars of letters, digits, dot, dash or underscore.',
        }, cors);
      }

      const sources = normaliseSources(input.sources);
      if (!sources.length) {
        return json(400, {
          error: 'Provide at least one source as { "sources": [{ "owner": "0x…", "namespace": "…" }] }.',
        }, cors);
      }
      if (sources.some((s) => !isAddress(s.owner) || !isSafeName(s.namespace))) {
        return json(400, { error: 'Each source needs a valid owner address and namespace.' }, cors);
      }

      const gate = await checkSubscription(env, address);
      if (!gate.ok) return json(gate.status, { ok: false, address, ...gate.body }, cors);

      const id = viewId(address, name);
      const existing = await readView(env, id);

      if (!existing) {
        const cap = Number(env.MAX_VIEWS_PER_WALLET || 0);
        if (cap > 0) {
          const mine = (await listViews(env)).filter((v) => v.requester === address);
          if (mine.length >= cap) {
            return json(429, {
              ok: false,
              error: `This wallet already has ${mine.length} view(s), the current limit.`,
            }, cors);
          }
        }
      }

      const view = {
        id,
        requester: address,
        name,
        sources,
        hostedMcp: Boolean(input.hostedMcp),
        mcp: existing?.mcp ?? null,
        createdAt: existing?.createdAt ?? Math.floor(Date.now() / 1000),
      };

      // Provision (or tear down) the hosted MCP to match the checkbox. Failures are
      // reported but never lose the view — the search endpoint works without it.
      let mcpError = null;
      try {
        if (view.hostedMcp) {
          view.mcp = await ensureMcp(env, view, url);
        } else if (existing?.mcp) {
          await deleteMcpService(env, id);
          view.mcp = null;
        }
      } catch (err) {
        mcpError = err.message;
        view.hostedMcp = false;
      }

      await env.REGISTRY_KV.put(viewKey(id), JSON.stringify(view));
      await env.REGISTRY_KV.put(dnsKey(dnsLabel(id)), id);
      return json(existing ? 200 : 202, {
        ok: true,
        ...withUrls(view, url, env),
        ...(mcpError ? { mcpError } : {}),
        note: `The instance embeds any new namespace within its poll interval (${env.POLL_HINT_SECONDS || 60}s).`,
      }, cors);
    }

    return json(404, { error: `Unknown route ${url.pathname}` }, cors);
  },
};

/* ─────────────────────────────── views ──────────────────────────────────── */

const viewKey = (id) => `view:${id}`;
const dnsKey = (label) => `dns:${label}`;
const trimLead = (p) => p.replace(/^\/+/, '');

/**
 * DNS label for a view: the id with underscores turned into hyphens, matching the
 * Cloud Run service name so a view's subdomain and its MCP service never disagree.
 * The reverse map is stored rather than computed — a view name may itself contain a
 * hyphen, so the transform is not invertible.
 */
const dnsLabel = (id) => serviceName(id);

/**
 * Resolve a view from `<label>.<VIEW_DOMAIN_SUFFIX>`.
 * `matched` says the hostname belongs to the view domain; `id` may still be null when
 * no view claims that label. The two are distinct so an unknown subdomain 404s rather
 * than falling through to the apex API.
 */
async function resolveHostView(env, url) {
  const suffix = (env.VIEW_DOMAIN_SUFFIX || '').replace(/^\./, '');
  if (!suffix || !url.hostname.endsWith(`.${suffix}`)) return { matched: false, id: null };
  const label = url.hostname.slice(0, -(suffix.length + 1));
  if (!label || label.includes('.')) return { matched: false, id: null };
  return { matched: true, id: await env.REGISTRY_KV.get(dnsKey(label)) };
}

/**
 * Deterministic id, derived from the requester and the view's name — which is what
 * makes POST /views an idempotent replace rather than a duplicate, and lets two
 * different wallets both own a view called "music".
 */
function viewId(requester, name) {
  return `qb_${requester.slice(2, 10).toLowerCase()}_${slug(name)}`;
}

/**
 * CDN domain for one source. MUST match `_domain_for` in quickbeam/watcher.py — the
 * watcher names the directory, this names it back to filter a view's catalog.
 */
function domainFor(owner, namespace) {
  return `${slug(owner.slice(2, 10))}-${slug(namespace)}`;
}

const viewDomains = (view) => new Set(view.sources.map((s) => domainFor(s.owner, s.namespace)));

function slug(text) {
  return (text || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'x';
}

const isSafeName = (s) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(s || '');

function normaliseSources(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const owner = String(item.owner || '').trim().toLowerCase();
    const namespace = String(item.namespace || '').trim();
    if (owner && namespace) seen.set(`${owner}:${namespace}`, { owner, namespace });
  }
  return [...seen.values()];
}

/**
 * What a requester is actually given. `searchUrl` is the per-view subdomain when the
 * zone is configured, since that is the URL a browser should call; `mcpCommand` is the
 * self-hosted fallback, and `mcp.url` the hosted service once Cloud Run has one.
 */
function withUrls(view, url, env) {
  const suffix = ((env && env.VIEW_DOMAIN_SUFFIX) || '').replace(/^\./, '');
  const base = suffix
    ? `https://${dnsLabel(view.id)}.${suffix}`
    : `${url.origin}/q/${view.id}`;
  const cdn = `${base}/cdn`;
  return {
    ...view,
    searchUrl: `${base}/search`,
    cdnUrl: cdn,
    mcpCommand: `quickbeam mcp --cdn-url ${cdn}`,
  };
}

/**
 * Refresh a hosted MCP's URL on read. Cloud Run assigns it asynchronously, so a view
 * created a moment ago comes back `provisioning`; this is what turns it `ready`
 * without needing a callback or a poller. Persists the result so the lookup happens
 * once, not on every read.
 */
async function withMcpStatus(env, view) {
  if (!view.mcp || view.mcp.url || !gcpConfigured(env)) return view;
  try {
    const live = await getMcpService(env, view.id);
    if (live.url) {
      const updated = { ...view, mcp: { ...view.mcp, status: live.status, url: live.url } };
      const { searchUrl, cdnUrl, mcpCommand, ...row } = updated;
      await env.REGISTRY_KV.put(viewKey(view.id), JSON.stringify(row));
      return updated;
    }
  } catch {
    // A status lookup failing must not break reading the view.
  }
  return view;
}

/** Provision the view's hosted MCP, pointed at its own filtered catalog. */
async function ensureMcp(env, view, url) {
  if (!gcpConfigured(env)) {
    throw new Error('Hosted MCP is not configured on this deployment (GCP_* vars unset).');
  }
  const cdnUrl = withUrls(view, url, env).cdnUrl;
  const created = await createMcpService(env, { viewId: view.id, cdnUrl });
  // Cloud Run assigns the URL asynchronously; GET /views/{id} refreshes it.
  const live = await getMcpService(env, view.id).catch(() => created);
  return { service: serviceName(view.id), status: live.status, url: live.url ?? null };
}

async function readView(env, id) {
  if (!id) return null;
  const raw = await env.REGISTRY_KV.get(viewKey(id));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Every view. KV list pages at 1000 keys — fine for a prototype, and the ceiling to
 * remember before this becomes the product.
 */
async function listViews(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.REGISTRY_KV.list({ prefix: 'view:', cursor });
    for (const key of page.keys) {
      const raw = await env.REGISTRY_KV.get(key.name);
      if (raw) out.push(JSON.parse(raw));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/* ───────────────────────────── entitlement ──────────────────────────────── */

/**
 * An active storage subscription entitles a wallet to Quickbeam. One eth_call gives
 * both halves — `registered` is the SubscriptionRegistry's cross-call to
 * DataRegistry.isRegistered, `paidAt` the last payment. The active window is applied
 * here so it stays tunable without a contract redeploy.
 */
async function checkSubscription(env, address) {
  if ((env.STUB_GATE ?? 'false') === 'true') return { ok: true };

  let access;
  try {
    access = await readAccess(env, address);
  } catch (err) {
    return { ok: false, status: 502, body: { error: `Subscription check failed: ${err.message}` } };
  }

  if (!access.registered) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'This wallet is not a registered publisher.',
        registerUrl: env.REGISTER_URL || 'https://fangorn.network',
      },
    };
  }
  if (!isWithinWindow(env, access.paidAt)) {
    return {
      ok: false,
      status: 402,
      body: {
        error: 'Quickbeam requires an active subscription.',
        subscribeUrl: env.SUBSCRIBE_URL || 'https://fangorn.network',
      },
    };
  }
  return { ok: true };
}

async function readAccess(env, address) {
  const rpcUrl = env.RPC_URL || DEFAULT_RPC_URL;
  const contract = env.SUBSCRIPTION_CONTRACT_ADDRESS;
  if (!isAddress(contract)) {
    throw new Error('SUBSCRIPTION_CONTRACT_ADDRESS is not set (or not a valid address) in wrangler.toml.');
  }

  const data = toFunctionSelector(env.ACCESS_FUNCTION || DEFAULT_ACCESS_FUNCTION) + encodeAddress(address);
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: contract, data }, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message || JSON.stringify(body.error)}`);
  return { registered: wordAt(body.result, 0) !== 0n, paidAt: wordAt(body.result, 1) };
}

function isWithinWindow(env, paidAt) {
  if (paidAt === 0n) return false;
  const windowSecs = BigInt(Number(env.SUBSCRIPTION_WINDOW_DAYS || 30) * 86400);
  return BigInt(Math.floor(Date.now() / 1000)) < paidAt + windowSecs;
}

function isAdmin(env, address) {
  return (env.ADMIN_WALLETS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(address);
}

/* ─────────────────────────────── proxy ──────────────────────────────────── */

/**
 * Forward a query to the shared instance, scoped to one view.
 *
 *   /q/{id}/search…       → SEARCH_URL/search… with the view's (owner,namespace)
 *                           pairs injected as `scope`, so the URL always means the
 *                           view's namespaces and a caller cannot widen it
 *   /q/{id}/cdn/catalog   → CDN_URL/catalog, FILTERED to the view's domains — this is
 *                           what scopes a requester's MCP to their datasets
 *   /q/{id}/cdn/<path>    → CDN_URL/<path>
 *
 * The instance speaks plain HTTP; a browser on HTTPS cannot call it directly (mixed
 * content). Proxying here means no per-namespace DNS record and no certificate.
 */
async function proxy(request, env, url, cors, resolved = null) {
  let id, path;
  if (resolved) {
    ({ id, path } = resolved);
  } else {
    const rest = url.pathname.slice('/q/'.length);
    const slash = rest.indexOf('/');
    if (slash < 1) {
      return json(404, { error: 'Proxy routes: /q/{viewId}/search, /q/{viewId}/cdn/*' }, cors);
    }
    id = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  }
  const view = await readView(env, id);
  if (!view) return json(404, { error: `No view ${id}` }, cors);

  let target;
  if (path === 'search' || path.startsWith('search/')) {
    const params = new URLSearchParams(url.search);
    // The view defines the scope; drop anything the caller supplied so the endpoint
    // cannot be widened past what the view covers.
    params.delete('scope');
    params.delete('owner');
    params.delete('namespace');
    for (const s of view.sources) params.append('scope', `${s.owner}:${s.namespace}`);
    target = `${trimSlash(env.SEARCH_URL)}/${path}?${params}`;
  } else if (path === 'cdn/catalog') {
    return filteredCatalog(env, view, cors);
  } else if (path.startsWith('cdn/')) {
    target = `${trimSlash(env.CDN_URL)}/${path.slice('cdn/'.length)}${url.search}`;
  } else {
    return json(404, { error: 'Proxy routes: /q/{viewId}/search, /q/{viewId}/cdn/*' }, cors);
  }

  if (!/^https?:\/\//.test(target)) {
    return json(503, { error: 'Instance URL is not configured.' }, cors);
  }

  const headers = new Headers(request.headers);
  headers.delete('host');
  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });
  } catch (err) {
    return json(502, { error: `Instance unreachable: ${err.message}` }, cors);
  }

  const out = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

/**
 * The instance's catalog, cut down to this view's domains. `quickbeam mcp` builds its
 * whole dataset list from whatever /catalog its --cdn-url returns, so filtering here
 * is what "provisioning an MCP" amounts to — no per-requester process anywhere.
 */
async function filteredCatalog(env, view, cors) {
  let catalog;
  try {
    const res = await fetch(`${trimSlash(env.CDN_URL)}/catalog`);
    if (!res.ok) return json(502, { error: `Catalog HTTP ${res.status}` }, cors);
    catalog = await res.json();
  } catch (err) {
    return json(502, { error: `Instance unreachable: ${err.message}` }, cors);
  }
  const wanted = viewDomains(view);
  return json(200, {
    ...catalog,
    domains: (catalog.domains || []).filter((d) => wanted.has(d.name)),
  }, cors);
}

const trimSlash = (s) => (s || '').replace(/\/$/, '');

/* ────────────────────── address-ownership proof ─────────────────────────── */

/**
 * Prove the caller controls `address`. Step one returns the exact challenge to sign;
 * step two verifies it. Freshness bounds replay without any server-side state.
 */
async function verifyCallerOwnsAddress(input, address, env) {
  const now = Math.floor(Date.now() / 1000);
  const challenge = buildChallengeMessage(address, now);

  const { message, signature } = input;
  if (!message || !signature) {
    return {
      ok: false,
      needsSignature: true,
      error: 'Sign the `challenge` message below with your wallet and resend it as { address, message, signature }.',
      challenge,
    };
  }

  const fail = () => ({
    ok: false,
    error: 'Verification failed. Please be sure you signed with the wallet you named.',
    challenge,
  });

  const parsed = parseChallengeMessage(message);
  if (!parsed) return fail();
  if (parsed.address.toLowerCase() !== address) return fail();
  if (message !== buildChallengeMessage(parsed.address, parsed.issuedAt)) return fail();

  const maxAge = Number(env.SIGNATURE_MAX_AGE || 300);
  const skew = 60;
  if (!(parsed.issuedAt <= now + skew && parsed.issuedAt >= now - maxAge)) return fail();

  let recovered;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    return fail();
  }
  if (recovered.toLowerCase() !== address) return fail();

  return { ok: true };
}

/** The exact message a caller must sign. Names what it authorizes, in plain words. */
function buildChallengeMessage(address, issuedAt) {
  return [
    'Fangorn Quickbeam request',
    '',
    'I am proving that I control the wallet address below so Quickbeam can create or',
    'remove a search view on my behalf. This signature moves no funds.',
    '',
    `Address: ${address}`,
    `Issued-At: ${issuedAt}`,
  ].join('\n');
}

function parseChallengeMessage(message) {
  if (typeof message !== 'string') return null;
  const addr = message.match(/^Address: (0x[0-9a-fA-F]{40})$/m);
  const issued = message.match(/^Issued-At: (\d{1,20})$/m);
  if (!addr || !issued) return null;
  return { address: addr[1], issuedAt: Number(issued[1]) };
}

/** Collect the request fields from the query string and/or a JSON body. */
async function readInput(request) {
  const q = new URL(request.url).searchParams;
  const out = {
    address: q.get('address')?.trim() || '',
    message: q.get('message') ?? undefined,     // signed verbatim — never trim
    signature: q.get('signature')?.trim() || undefined,
    name: q.get('name')?.trim() || '',
    id: q.get('id')?.trim() || '',
    sources: undefined,
    hostedMcp: q.get('hostedMcp') === 'true' || undefined,
  };
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (body && typeof body === 'object') {
      if (!out.address && typeof body.address === 'string') out.address = body.address.trim();
      if (out.message == null && typeof body.message === 'string') out.message = body.message;
      if (!out.signature && typeof body.signature === 'string') out.signature = body.signature.trim();
      if (!out.name && typeof body.name === 'string') out.name = body.name.trim();
      if (!out.id && typeof body.id === 'string') out.id = body.id.trim();
      if (Array.isArray(body.sources)) out.sources = body.sources;
      if (typeof body.hostedMcp === 'boolean') out.hostedMcp = body.hostedMcp;
    }
  }
  return out;
}

/* ─────────────────────────────── helpers ────────────────────────────────── */

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
 * CORS governs *browser* pages only. It is not an access gate — the signed ownership
 * proof is, and CLI/curl callers ignore CORS entirely.
 */
function corsHeaders(env, request) {
  const base = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  };
  const allowed = (env.ALLOWED_ORIGIN || '*').trim();
  if (allowed === '*') return { ...base, 'access-control-allow-origin': '*' };

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
