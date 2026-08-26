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
   contract's cross-call to `DataRegistry.isRegistered`, so one read covers both. The
   contract address comes from `@fangorn-network/sdk`, not from `wrangler.toml` — see
   *Configuration*.

An active *storage* subscription is the entitlement. There is no Quickbeam contract
and nothing here reads an event log.

## Routes

| Route | Auth | Does |
|---|---|---|
| `POST /views` | signature + subscription | create or replace a view (idempotent on `{requester, name}`); returns its id, search URL and MCP command. `hostedMcp: true` also provisions a Cloud Run MCP. `409` if another of your views already covers exactly these sources |
| `GET /views?requester=0x…` | none | that wallet's views (omit `requester` for all) |
| `GET /views/{id}` | none | one view |
| `GET /watchlist` | none | the deduplicated union the instance polls: `{"sources":[{app, owner, namespace}]}`. `owner`/`namespace` may be `*` (that whole app); dedup is on all three, so the same publisher:subspace in two apps stays two entries |
| `GET /q/{id}/search…` | none | proxied to the instance with the view's `scope` injected |
| `GET /q/{id}/export` | none | the whole view as one NDJSON stream (vectors included), for searching locally |
| `GET /q/{id}/stream` | none | SSE: which of the view's domains changed, so a client pulls instead of polling |
| `GET /q/{id}/cdn/catalog` | none | the instance catalog **filtered** to the view's domains |
| `GET /q/{id}/cdn/*` | none | proxied to the CDN (shards, manifests, edges); `domains/{name}/…` outside the view is `404`, not forwarded |
| `POST /views/remove` | requester signature | delete one of **your own** views by `{id}` |
| `POST /admin/remove` | admin signature | delete any view by `{id}` |

A wallet cannot end up with the same view twice. Sending a view under a name it
already uses **replaces** it — the id is `(requester, name)`, so that is how you change
what a view watches without changing its URLs. Sending the same source set under a
*second* name is refused with `409` naming the view that already covers it: a view is a
filter over the shared collection, so a duplicate would be the same search under two
URLs, two catalogs and two hosted MCPs to keep in step. Sources are compared as a set of
canonical `app:owner:namespace` triples, so order, a repeat, or an app spelled as a name
on one side and its id on the other make no difference. Two *different* wallets asking
for the same namespaces is not a duplicate — that is the whole design.

The search **and export** proxies both **strip any caller-supplied `scope`, `owner` or
`namespace`** before injecting the view's own pairs, so a view URL always means that
view's namespaces and cannot be widened by editing the query string.

The CDN proxy is gated the same way. Filtering `/cdn/catalog` only *hides* other
views' domains, and a domain name is derivable (`appSlug-owner8-namespace`) — so
`/q/{id}/cdn/domains/{name}/…` is checked against the view with the same matcher the
catalog filter uses, and a name outside the view `404`s without reaching the instance.
Non-`domains/` CDN paths still pass through.

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

Unticking the box on a later `POST /views` deletes the service; so does removing the
view (`POST /views/remove`, `POST /admin/remove`). If Cloud Run is unconfigured (`GCP_*` unset), the request returns
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

Nothing expires on its own — a view keeps being watched until somebody removes it.
Two routes, because they answer to different people:

**`POST /views/remove` — the requester's own.** Ownership only: the signing wallet must
be the view's `requester`, and an admin wallet gets **no** override here (that is what
`/admin/remove` is for). There is no subscription check either — a wallet whose
subscription has lapsed must still be able to stop being watched.

```sh
# Two steps, like every write here: collect the challenge, sign it, resend.
curl -s -X POST "$WORKER/views/remove" -H 'content-type: application/json' \
  -d '{"address":"0xYOU","id":"qb_147c24c5_music"}'
# → { "challenge": "..." }   sign it, then:
curl -s -X POST "$WORKER/views/remove" -H 'content-type: application/json' \
  -d '{"address":"0xYOU","id":"qb_147c24c5_music","message":"<challenge>","signature":"0x…"}'
```

The website exposes this as **Stop watching** inside each view on the dashboard.

**`POST /admin/remove` — any view.** Same body, same handshake, but the signer must be
in `ADMIN_WALLETS`. Add a founder by appending to it in `wrangler.toml` and redeploying.

Either route deletes the view's row, its `dns:` label and its hosted MCP (a Cloud Run
failure comes back as `207` + `mcpError`; the row is gone regardless). Its sources leave
the watchlist **only if no other view wants them** — the instance cancels its stream
from that on-chain head once the last view referencing it goes.

## Configuration

All `[vars]` in `wrangler.toml` except `GCP_SA_KEY`, which is a **secret**
(`wrangler secret put GCP_SA_KEY`) and is only needed if you enable hosted MCPs.

**The SubscriptionRegistry address is not configured here.** It comes from
`@fangorn-network/sdk` (`FangornConfig.subscriptionRegistryContractAddress`), the only
thing that knows which SubscriptionRegistry pairs with which DataRegistry — `access()`
cross-calls whichever registry the contract was wired to, so a stale pairing reads as
"unregistered" for every wallet and rejects every view with nothing in the logs to
explain it. **Repoint by bumping the SDK, then redeploying** (and redeploy
`pinata-url-provider`, which reads the same value, so the two gates cannot disagree).
A `[build]` guard aborts the deploy if the installed SDK carries no valid address.

| Var | Meaning |
|---|---|
| `SUBSCRIPTION_CONTRACT_ADDRESS` | **Normally unset.** Overrides the SDK's address, for repointing ahead of an SDK publish; taking it logs a warning naming what it replaced, and a malformed one fails the gate rather than falling back |
| `RPC_URL` | EVM JSON-RPC endpoint. Default: the SDK's `FangornConfig.rpcUrl` |
| `ACCESS_FUNCTION` | ABI signature of the access view (default `access(address)`) |
| `SUBSCRIPTION_WINDOW_DAYS` | active window, applied here so it is tunable without a contract redeploy |
| `STUB_GATE` | `"true"` skips the chain call — local dev only |
| `ADMIN_WALLETS` | comma-separated wallets allowed to tear down |
| `MAX_VIEWS_PER_WALLET` | abuse cap, not an entitlement; `"0"` disables |
| `SEARCH_URL`, `CDN_URL` | the instance, plain HTTP |
| `INSTANCE_TIMEOUT_MS` | how long the instance may take to *answer* a proxied request before it is a `502` (default `15000`). Bounds time-to-headers only — `/stream` and `/export` still stream for as long as they like |
| `VIEW_DOMAIN_SUFFIX` | per-view subdomains live under this; empty serves views at `/q/{id}/…` |
| `GCP_PROJECT`, `GCP_REGION`, `GCP_SA_EMAIL`, `QUICKBEAM_IMAGE` | hosted MCP; unset disables the feature |
| `GCP_SA_KEY` (**secret**) | the service-account JSON's `private_key`; needs `roles/run.admin` + `roles/iam.serviceAccountUser` |
| `SIGNATURE_MAX_AGE` | max age of a signed challenge, seconds |
| `ALLOWED_ORIGIN` | browser CORS only — not the access gate |

⚠️ If you do set the override, it must be a SubscriptionRegistry whose
`dataRegistry()` matches the registry the SDK publishes to. A mismatch reads as
"unregistered" for every wallet registered after a redeploy, while the admin wallet
keeps working and hides it in testing. Check before you set it:

```sh
cast call <addr> "dataRegistry()(address)" --rpc-url https://sepolia-rollup.arbitrum.io/rpc
# must equal FangornConfig.dataRegistryContractAddress
```

## Develop

```sh
pnpm install                # or npm install
npm test                    # node --test, 48 tests, no framework
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

- `GET /watchlist` and `GET /views` read every row, cached in one `snapshot:views` key
  (10 min TTL, dropped on every write) so a poll costs a `get` and not a KV **list** —
  the op capped at 1000/day on the free plan, which an instance polling every 60s
  exceeds on its own. Editing a `view:` row directly with `wrangler kv key put` does
  NOT invalidate it: delete `snapshot:views` too, or wait out the TTL.
- The rebuilt snapshot is one value, and KV lists page at 1000 keys; fine for a
  prototype, and the first thing to change if this becomes the product.
- KV is eventually consistent, so a just-created view can take a moment to appear in
  `/watchlist`. The instance converges on the next poll either way.
