# pinata-url-provider

A single-file Cloudflare Worker (`src/index.js`) that mints **Pinata presigned upload URLs** for wallets that prove address ownership and pass an on-chain access check. This allows callers to pin to IPFS without ever seeing the Pinata JWT.

**An app is sponsored storage**: its owner pays the subscription, accepts publishers, and
every upload is billed to the app named in the request. There is no default app and no
storage outside an app. The contracts are **Base Sepolia's** (`BaseSepoliaConfig` in the
installed SDK).

It deploys as **`pinata-url-provider-base`**
(`https://pinata-url-provider-base.fangorn-0be.workers.dev`). The older
`pinata-url-provider` worker is the Arbitrum deployment's: apps there still use it, and its
code predates this repo, so it is never redeployed. Base clients must pass this URL as
`signedUrl.workerUrl` until the SDK defaults to it.

Requests get validated on:

1. **App.** `appId` is required: the app the upload is for and billed to.
2. **Ownership proof.** The caller signs a timestamped challenge naming the address and the app, with the address's key (EIP-191 `personal_sign`). The worker recovers the signer and requires it to equal the claimed address, and the challenge to name the requested app.
3. **Access.** `AppRegistry.access(appId, caller)` returns `(canPublish, owner, expiresAt)` in one `eth_call`. `canPublish` is the contract's single rule for who an app provides storage to: the app is claimed, not taken down and not expired, the wallet is not banned network-wide, and the app's owner has accepted it and not suspended it. The owner is accepted when they claim the app.
4. **Daily budget.** The declared upload size is checked against the app's daily byte budget.
5. **Mint.** `POST /v3/files/sign` at Pinata, scoped to that size, to `PINATA_ALLOW_MIME_TYPES`, and to the caller's Pinata group within the app.

Step 3 is the only chain read a granted upload makes.

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
| `appId` | **Required.** 32-byte hex app id: the app the upload is for. The caller must be able to publish to it (`canPublish`), and the bytes are billed to **that app**. See *Apps and subscriptions*. |
| `message` | The challenge, signed verbatim (see *Ownership handshake*). |
| `signature` | 65-byte `personal_sign` signature of `message`. |
| `size` | Declared upload size in bytes. The minted URL is scoped to `size + 4096` (multipart headroom). This is what gets debited to the app's daily budget. Omitted → `DEFAULT_UPLOAD_SIZE`. |
| `uploadId` | Idempotency key. A retry reusing it re-mints a fresh single-use URL but is charged once. |

### Minting: responses

| Status | Body |
| --- | --- |
| `200` | `{ ok, address, uploadUrl, network, maxFileSize, expiresIn }` |
| `400` | invalid/missing address, a missing or malformed `appId`, or a non-positive-integer `size` |
| `401` | `{ ok: false, address, error, challenge }`. No signature, or it failed to verify (wrong key, tampered, stale, or signed for another app). Sign `challenge` and retry. |
| `402` | the app's subscription has expired or been cancelled. `error` names the app and its owner, who must renew (points at `SUBSCRIBE_URL`) |
| `403` | ownership proven, but the app provides this wallet no storage. `error` says which: the app is unclaimed or taken down; the wallet is banned network-wide; or the app's owner has not accepted it, or has suspended it from the app |
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

`appId` is required (there is no default app); a missing or bad one gives `400`. `dailyLimit` reports `0` when the budget is disabled, and `daily` reports `0` when `RATE_KV` is unbound. There is no authentication for this call since byte counts aren't sensitive.

## Ownership handshake

The chain reads alone prove *an address* may publish, not that the caller controls it. So every mint is a two-step handshake:

```
POST / { "address": "0x…", "appId": "0x…" }
→ 401 { ok: false, error: "Sign the `challenge`…", challenge: "Fangorn onchain-gate…\nApp: 0x…\nIssued-At: <unix>" }

POST / { "address": "0x…", "appId": "0x…", "message": "<challenge verbatim>", "signature": "0x…", "size": 1024 }
→ 200 { ok: true, uploadUrl, … }
```

The challenge names the app (`App: 0x…`), so a signature only ever buys uploads for that app. The signed `message` must be the canonical template verbatim for the request's `appId`, its `Issued-At` within `SIGNATURE_MAX_AGE` (default 300s, 60s skew allowed. This bounds replay without server-side state), and the recovered signer must equal `address`. Any failure returns the same message ("Verification failed. Please be sure you have the correct private key.") with a fresh challenge.

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

Every upload names an app and is charged to the app's subscription. One subscription covers every publisher the app accepted, and a wallet with no app to upload for cannot upload at all.

The AppRegistry is both the membership list and the paywall, and `access(appId, caller).canPublish` is the whole rule. When it is false, the worker explains why, in this order:

| Cause | Read | Response |
| --- | --- | --- |
| the app is unclaimed | `access().owner` is `0x0` | `403` |
| the subscription expired or was cancelled | `access().expiresAt` has passed | `402`, naming the owner |
| the app was taken down by the protocol admin | `isAppSuspended(appId)` | `403` |
| the wallet is banned network-wide | `globalSuspensions(caller)` | `403` |
| the app's owner suspended the wallet | `statusForApp(appId, caller)` is Suspended | `403` |
| the app's owner never accepted the wallet | `statusForApp(appId, caller)` is None (or the retired Invited) | `403`, saying to ask the owner |

Membership is the owner's call: they accept a wallet with `acceptPublisher`, and are accepted themselves when they claim the app. There are no invitations, terms or join fees. The explaining reads happen only on a denial; a granted upload makes none of them.

Expiry is enforced on-chain with no grace period, so the worker keeps no subscription policy of its own. An owner renews with ERC-5643 `renewSubscription`.

The AppRegistry address comes from `BaseSepoliaConfig` in `@fangorn-network/sdk`, with no env override.

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
  "https://api.pinata.cloud/v3/groups/public?name=testnet-base:"

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
curl "http://localhost:8787/?address=0xYourAddress&appId=0xYourAppId"   # → 401 + a challenge to sign
```

Contract addresses come from the installed SDK, so there is nothing to point at first. Every mint reads Base Sepolia; there is no mode that skips the chain.

`pnpm test` runs 42 cases (`node --test`, no framework) covering the handshake, the access gate and each denial, the byte budget, groups, and `/usage`. The chain and Pinata are stubbed.

## Deploy

From this directory (wrangler is a workspace dev dependency, so call it via `pnpm exec`. `../deploy.sh storage` wraps all of this):

```bash
pnpm exec wrangler login                    # first time only
pnpm exec wrangler secret put PINATA_JWT    # scoped key: Files→Write AND Groups→Write
pnpm exec wrangler kv namespace create RATE_KV   # paste the id into wrangler.toml
pnpm run deploy                             # `run` — bare `pnpm deploy` is a pnpm built-in
```

The Pinata key is **scoped, not Admin**, with two permissions: Files → Write (implies Read) to mint upload URLs, and Groups → Write to file each wallet's uploads. End users never see this JWT.

Secrets and KV belong to the worker name, so `pinata-url-provider-base` needs its own `PINATA_JWT` and its own namespace. Do not reuse the Arbitrum worker's (`524161f0…`), or apps of the same name on both chains share one daily budget.

Without the `RATE_KV` binding the daily cap does nothing and `/usage` reports zeroes. `RPC_URL` is optional and defaults to the SDK's public Base Sepolia endpoint.

## Configuration

`[vars]` in `wrangler.toml` where `PINATA_JWT` is the only secret.

| Var | Kind | Meaning |
| --- | --- | --- |
| `PINATA_JWT` | secret | Pinata key used to sign URLs and manage groups. Needs **Files: Write** + **Groups: Write**. |
| `PINATA_GROUP_PREFIX` | var | **Required.** Namespaces this deployment's per-wallet groups. Currently `testnet-base` (`testnet` held the Arbitrum-era pins); production is a separate deploy with its own prefix. |
| `PINATA_NETWORK` | var | `public` or `private`. Also selects the groups namespace. |
| `PINATA_URL_EXPIRES` | var | Seconds the upload URL stays valid (default `300`). |
| `PINATA_ALLOW_MIME_TYPES` | var | Optional CSV of MIME types signed into the URL. Pinata matches the type it detects from the file's bytes, not the declared one, so JSON uploads (records, ERC-8004 registration files) need `application/json` even when sent as `text/plain`. |
| `RPC_URL` | var | Base Sepolia JSON-RPC endpoint. Default: the SDK's `BaseSepoliaConfig.rpcUrl`. |
| `DAILY_BYTE_LIMIT` | var | Bytes per app per UTC day. `0`/unset disables the daily cap. |
| `MAX_UPLOAD_SIZE` | var | Per-request ceiling in bytes. A larger declared `size` in a request gets `413`. Defaults to 500 MiB. |
| `DEFAULT_UPLOAD_SIZE` | var | Size assumed when a caller omits `size`. Default 10 MiB. |
| `SIGNATURE_MAX_AGE` | var | Max age in seconds of the challenge's `Issued-At` (default `300`). |
| `SUBSCRIBE_URL` | var | URL shown in the `402` error, where the owner renews. |
| `ALLOWED_ORIGIN` | var | Browser CORS: `*` or a comma-separated allowlist. |
| `RATE_KV` | binding | Workers KV holding the byte counters and the group-id cache. The daily cap is inert without it. |


The AppRegistry address is not configurable. It comes from `BaseSepoliaConfig` in the installed SDK, and the `[build]` guard in `wrangler.toml` refuses to deploy without it. To check what a deployment is wired to:

```bash
cast call <DataRegistry> "appRegistry()(address)" --rpc-url https://base-sepolia-rpc.publicnode.com
# must equal BaseSepoliaConfig.appRegistryContractAddress
```
