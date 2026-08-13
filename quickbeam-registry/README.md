# quickbeam-registry

The control plane for Quickbeam, and the HTTPS front door to the instance that does
the work.

> Deploying the whole service — worker, instance, website, in order — is
> [`quickbeam/DEPLOYMENT.md`](../../quickbeam/DEPLOYMENT.md). This file is the worker
> on its own. `examples/manage-views.mjs` drives the signed routes from a shell.

Two ideas, kept apart:

- **Embedding is per `(owner, namespace)` and happens once.** The watch list this
  worker serves is the deduplicated **union** of every view's sources, so a second
  requester asking for an already-watched namespace costs one KV row and no embedding
  work.
- **Access is per requester.** A **view** is a named set of namespaces that gets its
  own search URL and its own MCP catalog. It is a *filter* over the shared collection,
  never a copy of the vectors.

Deduplication needs no refcount: a namespace is watched while at least one view
references it, and drops off the union when the last one goes.

```
website ──signed POST /views──▶ quickbeam-registry ──KV──┐
                                       ▲                 │
                                       └─ GET /watchlist ┴── polled by the instance

browser ─▶ /q/{view}/search  ─── scope injected ──▶ instance:8080
mcp     ─▶ /q/{view}/cdn     ─── catalog filtered ─▶ instance:8090
```

## No ownership check, and no access control on reads

You do **not** have to own a namespace to have it embedded — anyone with a
subscription can point a view at any public namespace. And a view id is a convenience,
not a secret: the source graphs are public on-chain data, so reads are open, the same
way the storage worker's `/usage` is. **Writes** are gated, because creating a view is
what spends embedding work.

## Entitlement

`POST /views` requires:

1. **Proof of the wallet** — an EIP-191 `personal_sign` over a challenge this worker
   builds. The first request returns the challenge; resend it with the signature.
   `Issued-At` bounds replay without any server-side state.
2. **An active subscription** — one `eth_call` to `access(address)` on the
   SubscriptionRegistry, which returns `(registered, paidAt)`. `registered` is that
   contract's cross-call to `DataRegistry.isRegistered`, so one read covers both.

An active *storage* subscription is the entitlement. There is no Quickbeam contract
and nothing here reads an event log.

## Routes

| Route | Auth | Does |
|---|---|---|
| `POST /views` | signature + subscription | create or replace a view (idempotent on `{requester, name}`); returns its id, search URL and MCP command. `hostedMcp: true` also provisions a Cloud Run MCP |
| `GET /views?requester=0x…` | none | that wallet's views (omit `requester` for all) |
| `GET /views/{id}` | none | one view |
| `GET /watchlist` | none | the deduplicated union the instance polls: `{"sources":[{app, owner, namespace}]}`. `owner`/`namespace` may be `*` (that whole app); dedup is on all three, so the same publisher:subspace in two apps stays two entries |
| `GET /q/{id}/search…` | none | proxied to the instance with the view's `scope` injected |
| `GET /q/{id}/export` | none | the whole view as one NDJSON stream (vectors included), for searching locally |
| `GET /q/{id}/stream` | none | SSE: which of the view's domains changed, so a client pulls instead of polling |
| `GET /q/{id}/cdn/catalog` | none | the instance catalog **filtered** to the view's domains |
| `GET /q/{id}/cdn/*` | none | proxied to the CDN (shards, manifests, edges) |
| `POST /admin/remove` | admin signature | delete a view by `{id}` |

The search **and export** proxies both **strip any caller-supplied `scope`, `owner` or
`namespace`** before injecting the view's own pairs, so a view URL always means that
view's namespaces and cannot be widened by editing the query string.

## Three ways to hold a copy locally

`GET /q/{id}/export` streams the view's entire corpus as NDJSON — `{track_id, fields,
embedding, owner, meta}` per line — with `content-disposition` set so a browser saves
`<viewId>.ndjson`. It pipes straight into another instance:

```sh
curl "$W/q/<viewId>/export" | curl -X POST http://localhost:8080/bundle/import --data-binary @-
```

`quickbeam pull` is the other route, and the better one once a corpus is large or
refreshed often:

```sh
quickbeam pull <domain> --cdn-url $W/q/<viewId>/cdn
```

| | `pull` (CDN shards) | `/q/{id}/export` (NDJSON) |
|---|---|---|
| Unit | one namespace per call | the whole view, one call |
| Resumable | yes (HTTP Range) | no — restart it |
| Verified | sha256 per shard | no |
| Incremental | yes, delta shards only | no, full corpus each time |
| Lands in | a local Qdrant, ready to serve | a file, parse it how you like |

Export is the simple thing to hand an application. Neither replaces the other.

### Staying current: `GET /q/{id}/stream`

Both of the above are pull. `/q/{id}/stream` is a Server-Sent Events feed that says
**when** to pull:

```
event: snapshot
data: {"domain":"147c24c5-secondbrain","count":27,"shards":1}

event: change
data: {"domain":"147c24c5-secondbrain","count":41,"added":["shard-0001-9f2c.ndjson.gz"]}
```

A client holds the connection and, on `change`, fetches the named shard from
`/q/{id}/cdn/domains/{domain}/shards/{file}` — reusing the sha256 verification and
dedup `pull` already does. `added` fires when a namespace is baked for the first time.

**Notifications, not rows, on purpose.** Points carry no timestamp or sequence, so a
row-carrying stream would have to re-send the whole corpus on every reconnect and would
discard the shard verification. Because the events are advisory, a reconnect just
re-sends `snapshot` and there is no history to replay.

The feed lives on the CDN service, which already owns the shard directory: the watcher
rewrites a domain's `manifest.json` when it appends a delta shard, so the manifest *is*
the change log. Latency is the poll interval (`--events-interval`, default 2s) plus the
watcher's own cycle. A re-bake that adds no shard emits nothing.

⚠️ The stream is **uncompressed**, and a 256-dim vector as decimal text dominates each
row — reckon on ~2.5 KB per record, so a 40k-record view is around 100 MB. It streams
rather than buffering, so size costs time, not memory.

## Per-view subdomains

Set `VIEW_DOMAIN_SUFFIX` and add the wildcard route, and every view is reachable at its
own hostname:

```
https://qb-147c24c5-music.qb.sond3r.com/search?q=…
```

which is the same request as `/q/qb_147c24c5_music/search?q=…`. The worker resolves the
view from the `Host` header via a `dns:{label}` reverse-map key. **Nothing is
provisioned per view** — the zone's wildcard record and Cloudflare's certificate cover
every label that will ever exist, so there is no DNS API call and no cert to renew.

The label is the view id with underscores turned into hyphens (DNS forbids
underscores), which is also the Cloud Run service name, so a view's subdomain and its
MCP service can never disagree.

Leave `VIEW_DOMAIN_SUFFIX` empty and views are served at `/q/{viewId}/…` on the
worker's own hostname instead. Both paths stay live either way.

## How a view becomes an MCP

`quickbeam mcp` is a **local pull-client**: its entire dataset list comes from whatever
`/catalog` its `--cdn-url` returns. So filtering that catalog *is* the per-user MCP.

**Self-hosted (default).** The user runs the client; the query never leaves their
machine:

```sh
quickbeam mcp --cdn-url https://qb-147c24c5-music.qb.sond3r.com/cdn
```

**Hosted (`hostedMcp: true`).** The worker creates one **Cloud Run** service per view,
running the same quickbeam image with `--cdn-url` pointed at that view's filtered
catalog, and returns its URL. An MCP is stateless, holds no connections and needs no
disk, so it scales to zero — an idle user's MCP costs nothing. That is the opposite of
the watcher, which is why the watcher lives on a VM.

Unticking the box on a later `POST /views` deletes the service; so does
`POST /admin/remove`. If Cloud Run is unconfigured (`GCP_*` unset), the request returns
an `mcpError` and the view still gets its search endpoint — the feature degrades, it
does not fail the view.

⚠️ The CDN domain name is built the same way in two languages: `domainFor()` here and
`_domain_for()` in `quickbeam/watcher.py`, both `{app}-{owner[2:10]}-{namespace}`. If
they drift, a view's catalog silently comes back empty — `quickbeam/tests/test_watchlist.py`
re-derives this file's version from source and fails if one side moves alone.

A wildcard source (`owner` and/or `namespace` = `*`) names no single domain, since the
watcher only learns its pairs as commits arrive. Those are matched on the parts that are
pinned — always the app — by `domainMatcher()`, and `/q/{id}/stream` resolves them by
asking the instance's catalog what actually exists.

⚠️ `DEFAULT_APP` is the app assumed for a source that names none, which is every view
stored before the app dimension existed. It must stay set to the app those views were
created against, and match the watcher's `APP`, or their catalogs come back empty.

## Teardown

Nothing expires on its own — a lapsed subscription keeps running until someone removes
its view. That is deliberate: teardown is a founder action.

```sh
# Any wallet in ADMIN_WALLETS. Two steps: collect the challenge, sign, resend.
curl -s -X POST "$WORKER/admin/remove" -H 'content-type: application/json' \
  -d '{"address":"0xYOURADMIN","id":"qb_147c24c5_music"}'
# → { "challenge": "..." }   sign it, then:
curl -s -X POST "$WORKER/admin/remove" -H 'content-type: application/json' \
  -d '{"address":"0xYOURADMIN","id":"qb_147c24c5_music","message":"<challenge>","signature":"0x…"}'
```

Removing a view drops its sources from the watchlist **only if no other view wants
them**. Add a founder by appending to `ADMIN_WALLETS` in `wrangler.toml` and
redeploying.

## Configuration

All `[vars]` in `wrangler.toml` except `GCP_SA_KEY`, which is a **secret**
(`wrangler secret put GCP_SA_KEY`) and is only needed if you enable hosted MCPs. A
`[build]` guard refuses to deploy unless `SUBSCRIPTION_CONTRACT_ADDRESS` is a
well-formed address, so the gate can never fall back to something wrong.

| Var | Meaning |
|---|---|
| `SUBSCRIPTION_CONTRACT_ADDRESS` | SubscriptionRegistry to read `access()` from |
| `RPC_URL`, `CHAIN_ID`, `ACCESS_FUNCTION` | how to make that call |
| `SUBSCRIPTION_WINDOW_DAYS` | active window, applied here so it is tunable without a contract redeploy |
| `STUB_GATE` | `"true"` skips the chain call — local dev only |
| `ADMIN_WALLETS` | comma-separated wallets allowed to tear down |
| `MAX_VIEWS_PER_WALLET` | abuse cap, not an entitlement; `"0"` disables |
| `SEARCH_URL`, `CDN_URL` | the instance, plain HTTP |
| `VIEW_DOMAIN_SUFFIX` | per-view subdomains live under this; empty serves views at `/q/{id}/…` |
| `GCP_PROJECT`, `GCP_REGION`, `GCP_SA_EMAIL`, `QUICKBEAM_IMAGE` | hosted MCP; unset disables the feature |
| `GCP_SA_KEY` (**secret**) | the service-account JSON's `private_key`; needs `roles/run.admin` + `roles/iam.serviceAccountUser` |
| `SIGNATURE_MAX_AGE` | max age of a signed challenge, seconds |
| `ALLOWED_ORIGIN` | browser CORS only — not the access gate |

⚠️ `SUBSCRIPTION_CONTRACT_ADDRESS` must be the SubscriptionRegistry whose
`dataRegistry()` matches the registry the SDK publishes to. A mismatch reads as
"unregistered" for every wallet registered after a redeploy, while the admin wallet
keeps working and hides it. Check with `cast call <addr> "dataRegistry()(address)"`.

## Develop

```sh
pnpm install                # or npm install
npm test                    # node --test, 30 tests, no framework
npx wrangler kv namespace create QUICKBEAM_KV   # paste the id into wrangler.toml
npx wrangler dev            # with STUB_GATE="true" to skip the on-chain check
npx wrangler deploy
```

The tests call the worker directly as `(request, env) => Response` with an in-memory KV
stub and stubbed RPC/instance fetches. Signatures are real EIP-191 signs via viem — the
same library the worker recovers them with — so the auth path is exercised, not mocked.
The two that encode the design are *"EMBED ONCE: two requesters, same namespace → one
watchlist entry"* and *"removing one view keeps the source for the other"*. The Cloud
Run tests sign a real throwaway RSA key, so the JWT path runs rather than being
stubbed — a malformed PEM would fail there, which is where it would fail in
production.

## Known ceilings

- `GET /watchlist` and `GET /views` read every row. KV lists page at 1000 keys; fine
  for a prototype, and the first thing to change if this becomes the product.
- KV is eventually consistent, so a just-created view can take a moment to appear in
  `/watchlist`. The instance converges on the next poll either way.
