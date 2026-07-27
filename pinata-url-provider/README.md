# pinata-url-provider

A tiny, self-contained Cloudflare Worker that gates a **Pinata presigned upload
URL** behind **on-chain registration** and a **storage subscription**, so wallets
can pin to IPFS without ever seeing your Pinata JWT.

Per request:

1. The caller proves control of an address by signing a one-time challenge. If the
   signature doesn't verify, the request is rejected ("Verification failed…").
2. One `eth_call` to `access(address)` on the **SubscriptionRegistry** returns
   `(registered, paidAt)` — the contract cross-calls `DataRegistry.isRegistered`
   internally, so a single read answers both "is this a publisher?" and "when did
   they last pay?". Not registered → the caller is told to register.
3. The declared upload size is checked against the wallet's **lifetime free tier**
   (past it, an active subscription is required) and its **daily byte budget**.
4. The worker mints a short-lived presigned upload URL scoped to that size, to the
   allowed MIME types, and to the wallet's own Pinata group, and returns it.

The only runtime dependency is [`viem`](https://viem.sh) (signature recovery +
selector encoding); everything else rides on the Workers `fetch` runtime. All
behaviour is configured through environment variables.

## Setup

This worker is one package in a pnpm workspace. Install once from the repo root,
then work inside this package:

```bash
pnpm install                            # from the repo root — installs viem + wrangler

cd webworker/pinata-url-provider
cp .dev.vars.example .dev.vars          # add your PINATA_JWT for local dev
```

Edit `wrangler.toml` `[vars]` to point at your SubscriptionRegistry, then run
locally:

```bash
pnpm dev
# → curl "http://localhost:8787/?address=0xYourAddress"
#   401 with a `challenge` to sign — the ownership handshake is always enforced
```

Set `STUB_REGISTRATION_CHECK = "true"` in `.dev.vars` to develop without an RPC
endpoint: the signature is still verified, but the chain is not read.

Run the tests with `pnpm test` (`node --test`, no framework, ~35 cases covering the
handshake, the access gate, the byte budgets, groups, and `/usage`).

## Deploy

Run these from `webworker/pinata-url-provider/`. Wrangler is installed locally by
the workspace, so call it via `pnpm exec wrangler …` (the `dev`/`deploy` npm scripts
already do).

**1. Authenticate** (first time only):

```bash
pnpm exec wrangler login
```

**2. Create the Pinata JWT.** In the Pinata dashboard, create a **scoped** API key
(not Admin) with two permissions — **Files → Write** (Write implies Read) and
**Groups → Write**. That is all the worker needs: it calls `POST /v3/files/sign`
to mint upload URLs, and the groups API to file each wallet's uploads under its
own group (see *Upload groups* below). A Files-only key `502`s on the group
create. Leave Gateways and Analytics off. End users never receive this JWT; they
upload with the short-lived presigned URL it produces.

**3. Set the secret** (never put it in `wrangler.toml`):

```bash
pnpm exec wrangler secret put PINATA_JWT    # the Files+Groups JWT from step 2
```

`RPC_URL` defaults to the public Arbitrum Sepolia endpoint in `wrangler.toml`, so
no RPC secret is required — override that var if you want a private endpoint.

**4. Create the KV namespace** backing the byte counters, and paste the id into the
`[[kv_namespaces]]` block in `wrangler.toml`:

```bash
pnpm exec wrangler kv namespace create RATE_KV
```

Without this binding the free tier and daily cap silently do nothing (see
*Byte budgets* below) and `/usage` reports zeroes.

**5. Configure the access check** in `wrangler.toml` `[vars]`:

- `SUBSCRIPTION_CONTRACT_ADDRESS` — the deployed SubscriptionRegistry the worker
  calls `access(address)` on. **Required, no default**: gating on a fallback
  contract silently is worse than failing, so the worker errors without it and a
  `[build]` guard in `wrangler.toml` aborts the deploy if it is missing or
  malformed.
- `RPC_URL` — defaults to the public Arbitrum Sepolia RPC; swap in your own for
  higher rate limits.
- Keep `STUB_REGISTRATION_CHECK = "false"` in production. Setting it `"true"`
  skips the on-chain read entirely — a valid signature alone yields a URL, and the
  subscription window is treated as active (dev only).
- `REGISTER_URL` / `SUBSCRIBE_URL` — shown in the `403` and `402` errors.
- Lock `ALLOWED_ORIGIN` to your site(s) if a browser calls the worker; leave it
  `"*"` if only CLIs/servers do (CORS does not apply to them).
- Tune `PINATA_NETWORK`, `PINATA_URL_EXPIRES`, `MAX_UPLOAD_SIZE`, and
  `PINATA_ALLOW_MIME_TYPES`.
- `PINATA_GROUP_PREFIX` — **required**; namespaces this deployment's upload
  groups (see below). `"testnet"` here; a production worker is a separate deploy
  with its own prefix.
- `FREE_BYTE_LIMIT`, `DAILY_BYTE_LIMIT`, `SUBSCRIPTION_WINDOW_DAYS` — the storage
  policy (see *Byte budgets*).

`wrangler.toml` also pins the deployment routing so `deploy` runs without
warnings: `workers_dev = true` keeps the `*.workers.dev` URL and
`preview_urls = false` disables per-version Preview URLs. If instead you serve
the worker from a custom domain/route, set `workers_dev = false` and add a
`[[routes]]` / `route` entry.

**6. Deploy:**

```bash
pnpm run deploy      # use `run` — bare `pnpm deploy` is a different built-in pnpm command
```

Wrangler prints the deployed URL (e.g.
`https://pinata-url-provider.<subdomain>.workers.dev`). Smoke-test it:

```bash
curl "https://<worker>/?address=0xYourAddress"
# → 401 with a `challenge` to sign
```

## Configuration

| Var | Where | Meaning |
| --- | --- | --- |
| `SUBSCRIPTION_CONTRACT_ADDRESS` | var | **Required, no default.** SubscriptionRegistry the worker calls `access(address)` on. A `[build]` guard blocks deploy if it's unset or malformed. |
| `RPC_URL` | var | EVM JSON-RPC endpoint. Default: public Arbitrum Sepolia. |
| `ACCESS_FUNCTION` | var | Optional. ABI signature of the access view (default `access(address)`). |
| `STUB_REGISTRATION_CHECK` | var | `"true"` skips the on-chain read — a valid signature alone yields a URL, and the subscription is treated as active (dev/testing). |
| `SUBSCRIPTION_WINDOW_DAYS` | var | How long a payment keeps a subscription active (default `30`). Enforced here, not on-chain. |
| `REGISTER_URL` | var | URL shown in the `403` "not registered" error (default `https://fangorn.network`). |
| `SUBSCRIBE_URL` | var | URL shown in the `402` "past the free tier" error. |
| `CHAIN_ID` | var | Informational only (`421614` = Arbitrum Sepolia); the worker never reads it. |
| `PINATA_JWT` | secret | Pinata JWT used to sign upload URLs and manage groups. Needs the **Files: Write** and **Groups: Write** scopes. |
| `PINATA_NETWORK` | var | `public` or `private`. Also selects which groups namespace is used. |
| `PINATA_URL_EXPIRES` | var | Seconds the upload URL stays valid (default `300`). |
| `PINATA_ALLOW_MIME_TYPES` | var | Optional CSV of allowed MIME types, signed into the URL. |
| `PINATA_GROUP_PREFIX` | var | **Required.** Namespaces this deployment's per-wallet upload groups (see *Upload groups*). |
| `MAX_UPLOAD_SIZE` | var | Per-request ceiling in bytes; a larger declared `size` gets `413`. Default 500 MiB. |
| `DEFAULT_UPLOAD_SIZE` | var | Size assumed when a caller omits `size` (older SDKs). Default 10 MiB. |
| `FREE_BYTE_LIMIT` | var | Lifetime free bytes per wallet. `0`/unset disables the free-tier + subscription gate. |
| `DAILY_BYTE_LIMIT` | var | Bytes per wallet per UTC day. `0`/unset disables the daily cap. |
| `RATE_KV` | binding | Workers KV namespace holding the byte counters and the wallet→group cache. Both byte limits are inert without it. |
| `SIGNATURE_MAX_AGE` | var | Max age in seconds of the challenge's `Issued-At` (default `300`). |
| `ALLOWED_ORIGIN` | var | Browser CORS: `*` or a comma-separated allowlist. Does not affect CLI/server callers. |

The worker calls `access(address)` (a `view` returning `(bool, uint64)`) on
`SUBSCRIPTION_CONTRACT_ADDRESS` and gates on the result. That contract is a
**Stylus** (Rust) contract whose `access` method is exposed in the ABI as camelCase
— that is the default; override `ACCESS_FUNCTION` only if yours differs. The worker
never calls the DataRegistry directly; registration reaches it as the
SubscriptionRegistry's internal cross-call.

## Request

`GET` with query parameters or `POST` with a JSON body — both accept the same
fields.

| Field | Meaning |
| --- | --- |
| `address` | The wallet requesting an upload URL. Required. |
| `message` | The challenge, signed verbatim. See *Proving address ownership*. |
| `signature` | 65-byte `personal_sign` signature of `message`. |
| `size` | Declared upload size in bytes. The SDK sends the exact byte length; the minted URL is scoped to `size + 4096` (multipart headroom) and this is what gets debited. Omitted → `DEFAULT_UPLOAD_SIZE`. |
| `uploadId` | Idempotency key. A retry reusing it re-mints a fresh single-use URL but is only charged once. |

## Responses

| Status | Body |
| --- | --- |
| `200` | `{ ok: true, address, uploadUrl, network, maxFileSize, expiresIn }` — plus `stubbed: true` when `STUB_REGISTRATION_CHECK` is on |
| `204` | CORS preflight (`OPTIONS`) |
| `400` | invalid/missing address, or a non-positive-integer `size` |
| `401` | `{ ok: false, address, error, challenge }` — no signature yet, or verification failed ("…correct private key"); sign `challenge` and retry |
| `402` | `{ ok: false, address, error: "To continue using Fangorn's storage…" }` — past the free tier with no active subscription |
| `403` | `{ ok: false, address, error: "This public key is not registered…" }` — ownership proven, but the address isn't a registered publisher |
| `405` | method other than `GET`/`POST`/`OPTIONS` |
| `413` | declared `size` exceeds `MAX_UPLOAD_SIZE` |
| `429` | the wallet's daily byte budget is exhausted (resets 00:00 UTC) |
| `502` | RPC, group, or Pinata sign call failed (see `detail`) |

No URL is minted on any non-`200`, and the byte counters are debited **only** after
a successful mint — a failed mint costs no quota.

## Byte budgets

Two independent limits, both backed by the `RATE_KV` namespace and both **opt-in**:
each is inert unless its limit is `> 0` *and* `RATE_KV` is bound.

**Lifetime free tier** (`FREE_BYTE_LIMIT`, KV key `total:{wallet}`, no expiry). A
wallet's first `FREE_BYTE_LIMIT` bytes are free. Once an upload would cross that
line — including the upload that crosses it — the worker requires an **active
subscription**: `now − paidAt < SUBSCRIPTION_WINDOW_DAYS`, using the `paidAt` from
the `access()` read. Otherwise `402`. The counter keeps climbing past the limit, so
a wallet can't dip back under it and get free uploads again.

The window lives here rather than on-chain (the contract only stores a timestamp),
so pricing policy is tunable without a contract redeploy. The worker never learns
*how* the fee was paid — only that `paidAt` advanced — so changing the fee currency
needs no worker change. Keep this in sync with the website's display constant.

**Daily cap** (`DAILY_BYTE_LIMIT`, KV key `bytes:{wallet}:{UTC-day}`, 2-day TTL).
An abuse guard applied to everyone, free and subscribed alike: exceed it and you get
`429` until 00:00 UTC.

Retries reuse the caller's `uploadId` (marker `paid:{wallet}:{uploadId}`, 1-hour
TTL) so one logical upload is charged once across attempts; a re-mint at the same or
smaller size is free, a larger one is charged normally.

KV is eventually consistent, so a concurrent burst across edge locations can
overshoot slightly. This is a soft cost guard, not exact enforcement — swap to a
Durable Object if you need the latter.

## `GET /usage?address=0x…`

A read-only, **unauthenticated** endpoint returning a wallet's counters so a
dashboard can show usage:

```json
{ "ok": true, "address": "0x…",
  "total": 12345, "freeLimit": 1073741824,
  "daily": 2048,  "dailyLimit": 5368709120,
  "day": "2026-07-27" }
```

Limits report `0` when that budget is disabled, and the counters report `0` when
`RATE_KV` isn't bound. Unauthenticated by design: byte counts aren't sensitive,
while the money action — minting an upload URL — still requires the signed proof.
A bad or missing address gives `400`.

Note this counts only bytes granted *through this worker*. A publisher using their
own Pinata JWT uploads directly and is never seen here.

## Upload groups

Every presigned URL is scoped to a Pinata **group** named
`<PINATA_GROUP_PREFIX>:<wallet>` — one group per wallet, namespaced per
deployment. The worker resolves it from KV, falling back to a lookup by name and
then creating it on the wallet's first upload. `group_id` is signed into the
upload URL, so the uploader cannot file the pin anywhere else; if the group can't
be resolved the request `502`s and **no URL is minted** — a pin filed under no
group is a pin no cleanup job can find.

That makes a whole deployment's pins sweepable without any upload record. To unpin
everything a deployment ever stored (e.g. retiring testnet data):

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

## Uploading with the returned URL

The URL is single-use, so a client runs one handshake per upload:

```js
// after the handshake below yields { uploadUrl, network }
const fd = new FormData();
fd.append('file', file);          // a File/Blob
fd.append('network', network);    // must match the signed URL's network
const pin = await fetch(uploadUrl, { method: 'POST', body: fd }).then((r) => r.json());
// pin.data.cid → the IPFS CID
```

## Proving address ownership

The registration check alone only proves that **an address** is registered — not
that the caller controls it. To close that gap the worker **always** requires the
caller to **sign a challenge** with the address's private key and verifies the
signature (EIP-191 `personal_sign`) in `verifyCallerOwnsAddress()`
(`src/index.js`), recovering the signer with viem's `recoverMessageAddress`. A
signature that doesn't recover to the claimed address fails with **"Verification
failed. Please be sure you have the correct private key."**

### The handshake

1. Caller requests without a signature and gets back the exact message to sign:

   ```
   POST / { "address": "0x…" }
   → 401 { ok:false, error:"Sign the `challenge`…", challenge:"Fangorn onchain-gate…\nIssued-At: <unix>" }
   ```

2. Caller signs `challenge` with the address's key and resends:

   ```
   POST / { "address":"0x…", "message":"<challenge verbatim>", "signature":"0x…65 bytes", "size":1024 }
   → 200 { ok:true, uploadUrl, … }   (or 403 / 402 / 429)
   ```

The worker requires the signed `message` to be the canonical challenge verbatim,
its `Issued-At` to be within `SIGNATURE_MAX_AGE` seconds (default 300, bounding
replay without server-side state, with 60s of clock skew allowed), and the
recovered signer to equal `address`.

CORS (`ALLOWED_ORIGIN`) governs *browser* pages only — it is not the access gate.
The signed proof is, and CLI/curl/server callers ignore CORS entirely.

### Try it

A runnable simulated caller lives in [`examples/`](examples/):

```bash
pnpm dev                                      # terminal 1
node examples/simulated-caller.mjs            # terminal 2
```

It performs the full handshake (request → sign → resend) end to end. See
[`examples/README.md`](examples/README.md).
</content>
