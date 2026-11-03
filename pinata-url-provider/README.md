# pinata-url-provider

A single-file Cloudflare Worker (`src/index.js`) that mints **Pinata presigned upload URLs** for wallets that prove address ownership. Callers pin to IPFS without ever seeing the Pinata JWT. Each publisher has a daily storage quota, and the worker a global one.

It deploys as **`pinata-url-provider-base`**
(`https://pinata-url-provider-base.fangorn-0be.workers.dev`). The older
`pinata-url-provider` worker is the Arbitrum deployment's, and is never redeployed.

Requests get validated on:

1. **Ownership proof.** The caller signs a timestamped challenge naming the address, with the address's key (EIP-191 `personal_sign`). The worker recovers the signer and requires it to equal the claimed address.
2. **Denylist.** An address the operator has denied (`deny:<address>` in `RATE_KV`) gets `403`.
3. **Quotas.** The declared upload size is checked against the publisher's daily quota and the worker's global one.
4. **Mint.** `POST /v3/files/sign` at Pinata, scoped to that size, to `PINATA_ALLOW_MIME_TYPES`, and to the caller's Pinata group.

The worker makes no chain reads.

## Endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET`/`POST` `/` | signed challenge | Mint an upload URL |
| `GET /usage?address=0x…` | none | A publisher's byte counter and limit |
| `OPTIONS *` | none | CORS preflight → `204` |

### Minting: request fields

Query parameters (`GET`) or a JSON body (`POST`).

| Field | Meaning |
| --- | --- |
| `address` | **Required.** The wallet requesting the URL, and charged for it. |
| `message` | The challenge, signed verbatim (see *Ownership handshake*). |
| `signature` | 65-byte `personal_sign` signature of `message`. |
| `size` | Declared upload size in bytes. The minted URL is scoped to `size + 4096` (multipart headroom). This is what the quotas are charged. Omitted → `DEFAULT_UPLOAD_SIZE`. |
| `uploadId` | Idempotency key. A retry reusing it re-mints a fresh single-use URL but is charged once. |

### Minting: responses

| Status | Body |
| --- | --- |
| `200` | `{ ok, address, uploadUrl, network, maxFileSize, expiresIn }` |
| `400` | invalid/missing address, or a non-positive-integer `size` |
| `401` | `{ ok: false, address, error, challenge }`. No signature, or it failed to verify (wrong key, tampered, or stale). Sign `challenge` and retry. |
| `403` | the address is denied |
| `405` | method other than `GET`/`POST`/`OPTIONS` |
| `413` | declared `size` exceeds `MAX_UPLOAD_SIZE` |
| `429` | the publisher's daily quota, or the worker's, is exhausted (resets 00:00 UTC) |
| `502` | the group or Pinata sign call failed (see `detail`) |

No URL is minted on any non-`200`, and the counters are debited **only** after a successful mint.

### `GET /usage?address=0x…`

```json
{ "ok": true, "address": "0x…",
  "daily": 2048,  "dailyLimit": 1073741824,
  "day": "2026-08-31" }
```

`dailyLimit` reports `0` when the quota is disabled, and `daily` reports `0` when `RATE_KV` is unbound.

## Ownership handshake

```
POST / { "address": "0x…" }
→ 401 { ok: false, error: "Sign the `challenge`…", challenge: "Fangorn upload request…\nIssued-At: <unix>" }

POST / { "address": "0x…", "message": "<challenge verbatim>", "signature": "0x…", "size": 1024 }
→ 200 { ok: true, uploadUrl, … }
```

The signed `message` must be the canonical template verbatim, its `Issued-At` within `SIGNATURE_MAX_AGE` (default 300s, 60s skew allowed), and the recovered signer must equal `address`. Any failure returns the same message ("Verification failed. Please be sure you have the correct private key.") with a fresh challenge.

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

## Quotas and the denylist

`DAILY_BYTE_LIMIT` is per publisher (KV key `bytes:{address}:{UTC-day}`), and `GLOBAL_DAILY_BYTE_LIMIT` covers everyone together (`bytes:all:{UTC-day}`), which bounds the Pinata bill however many wallets ask. Both have a 2-day TTL, and each is off at `0` or unset.

**Retries** reuse the caller's `uploadId` (marker `paid:{address}:{uploadId}`, 1-hour TTL), so one logical upload is charged once; a re-mint at the same or smaller size is free, a larger one is charged normally.

KV is eventually consistent and allows one write per second per key, so a concurrent burst can overshoot slightly.

To refuse an address:

```bash
pnpm exec wrangler kv key put --binding RATE_KV "deny:0x<lowercase address>" 1
```

## Upload groups

Every presigned URL is scoped to a Pinata **group** named `<PINATA_GROUP_PREFIX>:<wallet>`, so each publisher's pins sweep as a unit. Resolved KV cache → lookup by name → create on first use. `group_id` is signed into the URL, so the uploader cannot file the pin anywhere else. If the group can't be resolved the request `502`s and **no URL is minted**.

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
curl "http://localhost:8787/?address=0xYourAddress"   # → 401 + a challenge to sign
```

`pnpm test` runs 29 cases (`node --test`, no framework) covering the handshake, the denylist, both quotas, retries, groups, and `/usage`. Pinata is stubbed.

## Deploy

From this directory (wrangler is a workspace dev dependency, so call it via `pnpm exec`. `../deploy.sh storage` wraps all of this):

```bash
pnpm exec wrangler login                    # first time only
pnpm exec wrangler secret put PINATA_JWT    # scoped key: Files→Write AND Groups→Write
pnpm exec wrangler kv namespace create RATE_KV   # paste the id into wrangler.toml
pnpm run deploy                             # `run` — bare `pnpm deploy` is a pnpm built-in
```

The Pinata key is **scoped, not Admin**, with two permissions: Files → Write (implies Read) to mint upload URLs, and Groups → Write to file each wallet's uploads. End users never see this JWT.

Secrets and KV belong to the worker name, so `pinata-url-provider-base` needs its own `PINATA_JWT` and its own namespace.

Without the `RATE_KV` binding the quotas and the denylist do nothing, and `/usage` reports zeroes.

## Configuration

`[vars]` in `wrangler.toml` where `PINATA_JWT` is the only secret.

| Var | Kind | Meaning |
| --- | --- | --- |
| `PINATA_JWT` | secret | Pinata key used to sign URLs and manage groups. Needs **Files: Write** + **Groups: Write**. |
| `PINATA_GROUP_PREFIX` | var | **Required.** Namespaces this deployment's per-wallet groups. Currently `testnet-base` (`testnet` held the Arbitrum-era pins); production is a separate deploy with its own prefix. |
| `PINATA_NETWORK` | var | `public` or `private`. Also selects the groups namespace. |
| `PINATA_URL_EXPIRES` | var | Seconds the upload URL stays valid (default `300`). |
| `PINATA_ALLOW_MIME_TYPES` | var | Optional CSV of MIME types signed into the URL. |
| `DAILY_BYTE_LIMIT` | var | Bytes per publisher per UTC day. `0`/unset disables it. |
| `GLOBAL_DAILY_BYTE_LIMIT` | var | Bytes per UTC day for everyone together. `0`/unset disables it. |
| `MAX_UPLOAD_SIZE` | var | Per-request ceiling in bytes. A larger declared `size` in a request gets `413`. Defaults to 500 MiB. |
| `DEFAULT_UPLOAD_SIZE` | var | Size assumed when a caller omits `size`. Default 10 MiB. |
| `SIGNATURE_MAX_AGE` | var | Max age in seconds of the challenge's `Issued-At` (default `300`). |
| `ALLOWED_ORIGIN` | var | Browser CORS: `*` or a comma-separated allowlist. |
| `RATE_KV` | binding | Workers KV holding the byte counters, the denylist and the group-id cache. |

