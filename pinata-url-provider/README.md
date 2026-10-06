# pinata-url-provider

A single-file Cloudflare Worker (`src/index.js`) that mints **Pinata presigned upload URLs** for wallets that prove address ownership and pass an on-chain access check. This allows callers to pin to IPFS without ever seeing the Pinata JWT.

Nobody publishes outside an app, and **an app is a storage subscription**: claiming one
pays the fee, and every upload is billed to the app it lands in.

Requests get validated on:

1. **Ownership proof.** The caller signs a timestamped challenge with the address's key (EIP-191 `personal_sign`). The worker recovers the signer and requires it to equal the claimed address.
2. **Network standing.** `DataRegistry.getPublisherStatus(caller)` must be active: registered, and not suspended by the protocol admin.
3. **App membership.** `AppRegistry.access(appId, caller)` returns `(registered, owner, paidAt)` in one `eth_call`. `registered` is the same per-app check `DataRegistry.commitStateRoot` enforces: true only if the app's owner **added** the wallet and it accepted the current terms, and false for a suspended app or publisher. `appId` is the caller's, or the SDK's default app when they send none.
4. **Subscription.** `paidAt` — when the app was claimed or last renewed — must be within `SUBSCRIPTION_WINDOW_DAYS`. There is no free tier.
5. **Daily budget.** The declared upload size is checked against the app's daily byte budget.
6. **Mint.** `POST /v3/files/sign` at Pinata, scoped to that size, to `PINATA_ALLOW_MIME_TYPES`, and to the caller's Pinata group within the app.

Steps 2 and 3 are the only chain reads a granted upload makes, and they run together.

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET`/`POST` `/` | signed challenge | Mint an upload URL |
| `GET /usage?appId=0x…` | none | An app's byte counter and limit |
| `OPTIONS *` | none | CORS preflight → `204` |

### Minting: request fields

Query parameters (`GET`) or a JSON body (`POST`).

| Field | Meaning |
| --- | --- |
| `address` | **Required.** The wallet requesting the URL. |
| `message` | The challenge, signed verbatim (see *Ownership handshake*). |
| `signature` | 65-byte `personal_sign` signature of `message`. |
| `size` | Declared upload size in bytes. The minted URL is scoped to `size + 4096` (multipart headroom). This is what gets debited to the app's daily budget. Omitted → `DEFAULT_UPLOAD_SIZE`. |
| `uploadId` | Idempotency key. A retry reusing it re-mints a fresh single-use URL but is charged once. |
| `appId` | Optional 32-byte hex app id: the app being published to. The caller must be an active publisher in it, and the bytes are billed to **that app**. Omitted → the SDK's default app, under the same rules. See *Apps and subscriptions*. |

### Minting: responses

| Status | Body |
| --- | --- |
| `200` | `{ ok, address, uploadUrl, network, maxFileSize, expiresIn }` (plus `stubbed: true` under `STUB_REGISTRATION_CHECK`) |
| `400` | invalid/missing address, a non-positive-integer `size`, or a malformed `appId` |
| `401` | `{ ok: false, address, error, challenge }`. No signature or it failed to verify. Sign `challenge` and retry. |
| `402` | the app's subscription is inactive. `error` names the app and its owner, who must renew (points at `SUBSCRIBE_URL`) |
| `403` | ownership proven, but publishing is refused. `error` says which: the address is not registered or is suspended network-wide; the app is unclaimed or suspended; or the address was never added by the app's owner, was added but has not accepted the terms, is suspended from the app, or is on stale terms (points at `REGISTER_URL` where there is something to do there) |
| `405` | method other than `GET`/`POST`/`OPTIONS` |
| `413` | declared `size` exceeds `MAX_UPLOAD_SIZE` |
| `429` | the app's daily byte budget is exhausted (resets 00:00 UTC) |
| `502` | RPC, group, or Pinata sign call failed (see `detail`) |

No URL is minted on any non-`200`, and the counters are debited **only** after a successful mint. A failed mint costs no quota.

### `GET /usage?appId=0x…`

```json
{ "ok": true, "appId": "0x…",
  "daily": 2048,  "dailyLimit": 1073741824,
  "day": "2026-08-31" }
```

`appId` defaults to the SDK's default app. `dailyLimit` reports `0` when the budget is disabled, `daily` reports `0` when `RATE_KV` is unbound, and a bad `appId` gives `400`. There is no authentication for this call since byte counts aren't sensitive.

## Ownership handshake

The chain reads alone prove *an address* may publish, not that the caller controls it. So every mint is a two-step handshake:

```
POST / { "address": "0x…" }
→ 401 { ok: false, error: "Sign the `challenge`…", challenge: "Fangorn onchain-gate…\nIssued-At: <unix>" }

POST / { "address": "0x…", "message": "<challenge verbatim>", "signature": "0x…", "size": 1024 }
→ 200 { ok: true, uploadUrl, … }
```

The signed `message` must be the canonical template verbatim, its `Issued-At` within `SIGNATURE_MAX_AGE` (default 300s, 60s skew allowed. This bounds replay without server-side state), and the recovered signer must equal `address`. Any failure returns the same message ("Verification failed. Please be sure you have the correct private key.") with a fresh challenge.

A runnable end-to-end caller lives in [`examples/`](examples/):

```bash
pnpm dev                              # terminal 1
node examples/simulated-caller.mjs    # terminal 2
```

## Using the minted URL

The URL is single-use, so clients run one handshake per upload:

```js
const fd = new FormData();
fd.append('file', file);          // a File/Blob
fd.append('network', network);    // must match the signed URL's network
const pin = await fetch(uploadUrl, { method: 'POST', body: fd }).then((r) => r.json());
// pin.data.cid → the IPFS CID
```

## Apps and subscriptions

Every upload names an app (or falls back to the SDK's default one) and is charged to the app's subscription. One subscription covers every publisher in that app, and a wallet with no app to publish under cannot upload at all.

The AppRegistry is both the membership list and the paywall:

| Read | Meaning | Failure |
| --- | --- | --- |
| `access(appId, caller).owner` | who claimed the app | `403` when it is `0x0` (unclaimed) |
| `access(appId, caller).registered` | an active publisher on the current terms | `403`, with the cause spelled out |
| `access(appId, caller).paidAt` | when the app last paid | `402` outside the window |

Membership is only by invitation. The app's owner adds a wallet (`addPublisher`), and that wallet then accepts the terms (`registerForApp`). The owner is their own first publisher. On a `403` the worker makes two more AppRegistry reads (`isAppSuspended`, `statusForApp`) to say which cause it was: never added, added but not yet joined, suspended, on stale terms, or the whole app taken down. A granted upload makes neither.

The subscription window lives here, not on-chain (the contract only stores a timestamp), so pricing policy is tunable without a redeploy — keep `SUBSCRIPTION_WINDOW_DAYS` in sync with the website's display constant. The worker never learns *how* the fee was paid, only that `paidAt` advanced. An owner renews with `renewApp`.

Both contract addresses come from `@fangorn-network/sdk` with no env override.

## Daily byte budget

`DAILY_BYTE_LIMIT`, KV key `bytes:{appId}:{UTC-day}`, 2-day TTL. An abuse guard that bounds the Pinata bill: one budget per app, shared by all of its publishers. Exceeding it returns `429` until 00:00 UTC. It is **opt-in** — inactive unless the limit is `> 0` *and* `RATE_KV` is bound.

**Retries** reuse the caller's `uploadId` (marker `paid:{appId}:{uploadId}`, 1-hour TTL), so one logical upload is charged once; a re-mint at the same or smaller size is free, a larger one is charged normally.

KV is eventually consistent and allows one write per second per key, so a concurrent burst from an app's publishers can overshoot slightly.

## Upload groups

Every presigned URL is scoped to a Pinata **group** named `<PINATA_GROUP_PREFIX>:<appId>:<wallet>`: billed to the app, attributable to the publisher. Resolved KV cache → lookup by name → create on first use. `group_id` is signed into the URL, so the uploader cannot file the pin anywhere else. If the group can't be resolved the request `502`s and **no URL is minted**.

To retire testnet data:

```bash
# 1. every group for this deployment (page with ?pageToken=<next_page_token>)
curl -H "Authorization: Bearer $PINATA_JWT" \
  "https://api.pinata.cloud/v3/groups/public?name=testnet:"

# 2. per group id, its files (page the same way)
curl -H "Authorization: Bearer $PINATA_JWT" \
  "https://api.pinata.cloud/v3/files/public?group=<groupId>"

# 3. delete each file id
curl -X DELETE -H "Authorization: Bearer $PINATA_JWT" \
  "https://api.pinata.cloud/v3/files/public/<fileId>"
```

The `name` filter is a substring match, so keep prefixes distinct (`testnet` also
matches `testnet-old`).

## Local development

The workspace root is `webworker/`, not the repo root:

```bash
cd webworker && pnpm install
cd pinata-url-provider
cp .dev.vars.example .dev.vars     # add PINATA_JWT
pnpm dev
curl "http://localhost:8787/?address=0xYourAddress"   # → 401 + a challenge to sign
```

Contract addresses come from the installed SDK, so there is nothing to point at first. Set `STUB_REGISTRATION_CHECK = "true"` in `.dev.vars` to work without an RPC endpoint: the signature is still verified, but the chain is not read, so any wallet passes and the subscription reads as active.

`pnpm test` runs 43 cases (`node --test`, no framework) covering the handshake, the access gate, the subscription window, the byte budget, groups, and `/usage`.

## Deploy

From this directory (wrangler is a workspace dev dependency, so call it via `pnpm exec`. `../deploy.sh storage` wraps all of this):

```bash
pnpm exec wrangler login                    # first time only
pnpm exec wrangler secret put PINATA_JWT    # scoped key: Files→Write AND Groups→Write
pnpm exec wrangler kv namespace create RATE_KV   # paste the id into wrangler.toml
pnpm run deploy                             # `run` — bare `pnpm deploy` is a pnpm built-in
```

The Pinata key is **scoped, not Admin**, with two permissions: Files → Write (implies Read) to mint upload URLs, and Groups → Write to file each wallet's uploads. End users never see this JWT.

Without the `RATE_KV` binding the daily cap does nothing and `/usage` reports zeroes. `RPC_URL` is optional and defaults to the SDK's public Arbitrum Sepolia endpoint.

## Configuration

`[vars]` in `wrangler.toml` where `PINATA_JWT` is the only secret.

| Var | Kind | Meaning |
| --- | --- | --- |
| `PINATA_JWT` | secret | Pinata key used to sign URLs and manage groups. Needs **Files: Write** + **Groups: Write**. |
| `PINATA_GROUP_PREFIX` | var | **Required.** Namespaces this deployment's per-wallet groups. Currently `testnet`; production is a separate deploy with its own prefix. |
| `PINATA_NETWORK` | var | `public` or `private`. Also selects the groups namespace. |
| `PINATA_URL_EXPIRES` | var | Seconds the upload URL stays valid (default `300`). |
| `PINATA_ALLOW_MIME_TYPES` | var | Optional CSV of MIME types signed into the URL. |
| `RPC_URL` | var | EVM JSON-RPC endpoint. Default: the SDK's `FangornConfig.rpcUrl`. |
| `STUB_REGISTRATION_CHECK` | var | `"true"` skips the chain reads entirely: a valid signature alone mints, and the subscription reads as active. Dev only. |
| `SUBSCRIPTION_WINDOW_DAYS` | var | How long a payment keeps an app's subscription active (default `30`). |
| `DAILY_BYTE_LIMIT` | var | Bytes per app per UTC day. `0`/unset disables the daily cap. |
| `MAX_UPLOAD_SIZE` | var | Per-request ceiling in bytes. A larger declared `size` in a request gets `413`. Defaults to 500 MiB. |
| `DEFAULT_UPLOAD_SIZE` | var | Size assumed when a caller omits `size`. Default 10 MiB. |
| `SIGNATURE_MAX_AGE` | var | Max age in seconds of the challenge's `Issued-At` (default `300`). |
| `REGISTER_URL` / `SUBSCRIBE_URL` | var | URLs shown in the `403` and `402` errors. |
| `ALLOWED_ORIGIN` | var | Browser CORS: `*` or a comma-separated allowlist. |
| `RATE_KV` | binding | Workers KV holding the byte counters and the group-id cache. The daily cap is inert without it. |


The DataRegistry and AppRegistry addresses are not configurable. They come from `FangornConfig` in the installed SDK, and the `[build]` guard in `wrangler.toml` refuses to deploy without them. To check what a deployment is wired to:

```bash
cast call <DataRegistry> "appRegistry()(address)" --rpc-url <rpc>
# must equal FangornConfig.appRegistryContractAddress
```
