# pinata-url-provider

A single-file Cloudflare Worker (`src/index.js`) that mints **Pinata presigned upload URLs** for wallets that prove address ownership and pass an on-chain access check. This allows callers to pin to IPFS without ever seeing the Pinata JWT.

Requests get validated on:

1. **Ownership proof.** The caller signs a timestamped challenge with the address's key (EIP-191 `personal_sign`). The worker recovers the signer and requires it to equal the claimed address.
2. **Access check.** One `eth_call` to `access(address)` on the SubscriptionRegistry returns `(registered, paidAt)`. The contract cross-calls `DataRegistry.isRegistered` internally, so a single read answers both "is this
   a publisher?" and "when did they last pay?".
3. **App membership** *(only when the caller sends an `appId`)*. `AppRegistry.isRegisteredForApp(appId, caller)`. The same per-app check `DataRegistry.commitStateRoot` enforces then `SubscriptionRegistry.isAppSubscribed(appId)` for the app's owner. Budgets are then billed to that app's **owner**, not the caller.
4. **Budgets.** The declared upload size is checked against the billed wallet's lifetime free tier (past it, an active subscription is required) and its daily byte budget.
5. **Mint.** `POST /v3/files/sign` at Pinata, scoped to that size, to `PINATA_ALLOW_MIME_TYPES`, and to the wallet's own Pinata group.

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET`/`POST` `/` | signed challenge | Mint an upload URL |
| `GET /usage?address=0x…` | none | A wallet's byte counters and limits |
| `OPTIONS *` | none | CORS preflight → `204` |

### Minting: request fields

Query parameters (`GET`) or a JSON body (`POST`).

| Field | Meaning |
| --- | --- |
| `address` | **Required.** The wallet requesting the URL. |
| `message` | The challenge, signed verbatim (see *Ownership handshake*). |
| `signature` | 65-byte `personal_sign` signature of `message`. |
| `size` | Declared upload size in bytes. The minted URL is scoped to `size + 4096` (multipart headroom). This is what gets debited to the account's storage limit. Omitted → `DEFAULT_UPLOAD_SIZE`. |
| `uploadId` | Idempotency key. A retry reusing it re-mints a fresh single-use URL but is charged once. |
| `appId` | Optional 32-byte hex app id. Publishes under an app: the caller must also be an active publisher in it, and the bytes are billed to the **app owner's** subscription. See *App-level subscriptions*. |

### Minting: responses

| Status | Body |
| --- | --- |
| `200` | `{ ok, address, uploadUrl, network, maxFileSize, expiresIn }` (plus `stubbed: true` under `STUB_REGISTRATION_CHECK`) |
| `400` | invalid/missing address, a non-positive-integer `size`, or a malformed `appId` |
| `401` | `{ ok: false, address, error, challenge }`. No signature or it failed to verify. Sign `challenge` and retry. |
| `402` | past the free tier with no active subscription. The caller's, or the app owner's for an app-scoped upload (points at `SUBSCRIBE_URL`) |
| `403` | ownership proven, but the address is not a registered publisher, not an active publisher in `appId`, or the app is unclaimed (points at `REGISTER_URL`) |
| `405` | method other than `GET`/`POST`/`OPTIONS` |
| `413` | declared `size` exceeds `MAX_UPLOAD_SIZE` |
| `429` | daily byte budget exhausted (resets 00:00 UTC) |
| `502` | RPC, group, or Pinata sign call failed (see `detail`) |

No URL is minted on any non-`200`, and the counters are debited **only** after a successful mint. A failed mint costs no quota.

### `GET /usage?address=0x…`

```json
{ "ok": true, "address": "0x…",
  "total": 12345, "freeLimit": 1073741824,
  "daily": 2048,  "dailyLimit": 1073741824,
  "day": "2026-08-31" }
```

Limits report `0` when that budget is disabled, counters `0` when `RATE_KV` is unbound, and a bad address gives `400`. There is no authentication for this call since byte counts aren't sensitive.

## Ownership handshake

The access check alone proves *an address* is registered, not that the caller controls it. So every mint is a two-step handshake:

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

## App-level subscriptions

A publisher may send an `appId` alongside the proof. The upload is then charged to the **app owner's** storage subscription, so one subscription covers every publisher in that app.

The caller still proves address ownership and still has to be registered in the DataRegistry. On top of that:

| Check | Contract | Failure |
| --- | --- | --- |
| `isRegisteredForApp(appId, caller)` | AppRegistry (from the SDK) | `403`. false for a suspended app, a suspended publisher, or stale accepted terms |
| `isAppSubscribed(appId) → (subscribed, owner)` | SubscriptionRegistry | `403` when `owner` is `0x0` (unclaimed app) |

Everything downstream then uses `owner` instead of the caller: the free-tier counter (`total:{owner}`), the daily cap, the `uploadId` idempotency marker, and the subscription window. `isAppSubscribed` only reports whether the owner has *ever* paid, so when the free tier is crossed the worker also reads `access(owner)` for `paidAt` and applies `SUBSCRIPTION_WINDOW_DAYS` exactly as it does for a solo publisher. Pins are grouped `<prefix>:<appId>:<caller>` and billed to the app owner and attributable to the publisher.

`GET /usage` is unchanged: query the **owner's** address to see an app's usage.

Both contract addresses come from `@fangorn-network/sdk` with no env override — `isAppSubscribed` resolves the AppRegistry through the DataRegistry itself, so an override here could only disagree with the contract.

## Byte budgets

There are two independent limits, both backed by `RATE_KV` and both **opt-in**. Each is inactive unless its limit is `> 0` *and* the namespace is bound.

In this section "wallet" means the wallet being **billed**: the caller, or the app owner when the request carries an `appId`.

**Lifetime free tier**: `FREE_BYTE_LIMIT`, KV key `total:{wallet}`, no expiry. The first `FREE_BYTE_LIMIT` bytes are free. Once an upload would cross that threshold (including the one that crosses it), the worker requires an active subscription: `now − paidAt < SUBSCRIPTION_WINDOW_DAYS`, using the `paidAt` from the `access()` read. Otherwise `402`. The counter keeps climbing past the limit, so a wallet can't dip back under it.

**Daily cap**: `DAILY_BYTE_LIMIT`, KV key `bytes:{wallet}:{UTC-day}`, 2-day TTL. An abuse guard on everyone, free and subscribed alike: exceeding it will return a `429` until 00:00 UTC.

**Retries** reuse the caller's `uploadId` (marker `paid:{wallet}:{uploadId}`, 1-hour TTL), so one logical upload is charged once; a re-mint at the same or smaller size is free, a larger one is charged normally.

The subscription window lives here, not on-chain (the contract only stores a timestamp), so pricing policy is tunable without a redeploy — keep it in sync with the website's display constant. The worker never learns *how* the fee was paid, only that `paidAt` advanced.

KV is eventually consistent, so a concurrent burst across edge locations can overshoot slightly.

## Upload groups

Every presigned URL is scoped to a Pinata **group** named `<PINATA_GROUP_PREFIX>:<wallet>` (or `<PINATA_GROUP_PREFIX>:<appId>:<wallet>` for an app-scoped upload). Resolved KV cache → lookup by name → create on first use. `group_id` is signed into the URL, so the uploader cannot file the pin anywhere else. If the group can't be resolved the request `502`s and **no URL is minted**.

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

Contract addresses come from the installed SDK, so there is nothing to point at first. Set `STUB_REGISTRATION_CHECK = "true"` in `.dev.vars` to work without an RPC endpoint: the signature is still verified, but the chain is not read, and the subscription reads as active.

`pnpm test` runs 37 cases (`node --test`, no framework) covering the handshake, the access gate, the byte budgets, groups, and `/usage`.

## Deploy

From this directory (wrangler is a workspace dev dependency, so call it via `pnpm exec`. `../deploy.sh storage` wraps all of this):

```bash
pnpm exec wrangler login                    # first time only
pnpm exec wrangler secret put PINATA_JWT    # scoped key: Files→Write AND Groups→Write
pnpm exec wrangler kv namespace create RATE_KV   # paste the id into wrangler.toml
pnpm run deploy                             # `run` — bare `pnpm deploy` is a pnpm built-in
```

The Pinata key is **scoped, not Admin**, with two permissions: Files → Write (implies Read) to mint upload URLs, and Groups → Write to file each wallet's uploads. End users never see this JWT.

Without the `RATE_KV` binding the free tier and daily cap do nothing and `/usage` reports zeroes. `RPC_URL` is optional and defaults to the SDK's public Arbitrum Sepolia endpoint.

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
| `SUBSCRIPTION_CONTRACT_ADDRESS` | var | **Normally unset**. Worker uses address from Fangorn's SDK. |
| `ACCESS_FUNCTION` | var | ABI signature of the access view (default `access(address)`). |
| `STUB_REGISTRATION_CHECK` | var | `"true"` skips the chain read entirely: a valid signature alone mints, and the subscription reads as active. Dev only. |
| `SUBSCRIPTION_WINDOW_DAYS` | var | How long a payment keeps a subscription active (default `30`). |
| `FREE_BYTE_LIMIT` | var | Lifetime free bytes per wallet. `0`/unset disables the free-tier + subscription gate. |
| `DAILY_BYTE_LIMIT` | var | Bytes per wallet per UTC day. `0`/unset disables the daily cap. |
| `MAX_UPLOAD_SIZE` | var | Per-request ceiling in bytes. A larger declared `size` in a request gets `413`. Defaults to 500 MiB. |
| `DEFAULT_UPLOAD_SIZE` | var | Size assumed when a caller omits `size`. Default 10 MiB. |
| `SIGNATURE_MAX_AGE` | var | Max age in seconds of the challenge's `Issued-At` (default `300`). |
| `REGISTER_URL` / `SUBSCRIBE_URL` | var | URLs shown in the `403` and `402` errors. |
| `ALLOWED_ORIGIN` | var | Browser CORS: `*` or a comma-separated allowlist. |
| `RATE_KV` | binding | Workers KV holding the byte counters and the wallet→group cache. Both limits are inert without it. |


`SUBSCRIPTION_CONTRACT_ADDRESS` is an emergency override for repointing ahead of an SDK publish. Taking it logs a warning naming what it replaced. Verify the pairing first:

```bash
cast call <address> "dataRegistry()(address)" --rpc-url <rpc>
# must equal FangornConfig.dataRegistryContractAddress
```