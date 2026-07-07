# pinata-url-provider

A tiny, self-contained Cloudflare Worker that gates a **Pinata presigned upload
URL** behind an **on-chain condition**.

1. Caller → `GET https://<worker>/?address=0x…`
2. Worker makes a read-only `eth_call` to a configured contract view function on
   a configured EVM chain and compares the result to a configured condition.
3. If it passes, the worker mints a short-lived Pinata presigned upload URL and
   returns it. The caller uploads one file to IPFS without ever seeing your JWT.

The only runtime dependency is [`viem`](https://viem.sh) (for signature
recovery); everything else rides on the Workers `fetch` runtime. All behaviour is
configured through environment variables.

## Setup

This worker is one package in a pnpm workspace. Install once from the repo root,
then work inside this package:

```bash
pnpm install                       # from the repo root — installs viem + wrangler

cd pinata-url-provider
cp .dev.vars.example .dev.vars     # add RPC_URL and PINATA_JWT for local dev
```

Edit `wrangler.toml` `[vars]` to describe your gate, then run locally:

```bash
pnpm dev
# → curl "http://localhost:8787/?address=0xYourAddress"
```

## Deploy

Run these from `pinata-url-provider/`. Wrangler is installed locally by the
workspace, so call it via `pnpm exec wrangler …` (the `dev`/`deploy` npm scripts
already do).

**1. Authenticate** (first time only):

```bash
pnpm exec wrangler login
```

**2. Create the Pinata JWT.** In the Pinata dashboard, create a **scoped** API key
(not Admin) with a single permission — **Files → Write** (Write implies Read).
That is all the worker needs: it only calls `POST /v3/files/sign` to mint upload
URLs. Leave Groups, Gateways, and Analytics off. End users never receive this
JWT; they upload with the short-lived presigned URL it produces.

**3. Set the secrets** (never put these in `wrangler.toml`):

```bash
pnpm exec wrangler secret put PINATA_JWT    # the Files:Write JWT from step 2
pnpm exec wrangler secret put RPC_URL       # EVM JSON-RPC endpoint (skip if stubbing)
```

**4. Configure the gate** in `wrangler.toml` `[vars]`:

- Set `STUB_CONTRACT_CALL = "false"` so the on-chain check actually runs. Leaving
  it `"true"` hands a URL to anyone with a valid ownership signature — dev only.
- Fill in `CONTRACT_ADDRESS`, `VIEW_SELECTOR`, `PASS_ADDRESS_ARG`, `COMPARE_OP`,
  and `COMPARE_VALUE` for your condition (see [Configuration](#configuration)).
- Lock `ALLOWED_ORIGIN` to your site(s) if a browser calls the worker; leave it
  `"*"` if only CLIs/servers do (CORS does not apply to them).
- Tune `PINATA_NETWORK`, `PINATA_URL_EXPIRES`, and the optional
  `PINATA_MAX_FILE_SIZE` / `PINATA_ALLOW_MIME_TYPES` upload guards.

`wrangler.toml` also pins the deployment routing so `deploy` runs without
warnings: `workers_dev = true` keeps the `*.workers.dev` URL and
`preview_urls = false` disables per-version Preview URLs. If instead you serve
the worker from a custom domain/route, set `workers_dev = false` and add a
`[[routes]]` / `route` entry.

**5. Deploy:**

```bash
pnpm run deploy      # use `run` — bare `pnpm deploy` is a different built-in pnpm command
```

Wrangler prints the deployed URL (e.g.
`https://pinata-url-provider.<subdomain>.workers.dev`). Smoke-test it:

```bash
curl "https://<worker>/?address=0xYourAddress"
# → 401 with a `challenge` to sign — the ownership handshake is always enforced
```

## Configuration

| Var | Where | Meaning |
| --- | --- | --- |
| `RPC_URL` | secret | EVM JSON-RPC endpoint (any EVM chain). |
| `CONTRACT_ADDRESS` | var | Contract whose view function is called. |
| `VIEW_SELECTOR` | var | 4-byte selector, e.g. `cast sig "balanceOf(address)"` → `0x70a08231`. |
| `PASS_ADDRESS_ARG` | var | `"true"` appends the requestor address as the function's single arg. |
| `COMPARE_OP` | var | `gte` \| `gt` \| `lte` \| `lt` \| `eq` \| `nonzero` \| `zero` \| `bool`. |
| `COMPARE_VALUE` | var | Threshold compared as a bigint (ignored for `nonzero`/`zero`/`bool`). |
| `STUB_CONTRACT_CALL` | var | `"true"` skips the on-chain check — a valid signature alone yields a URL (dev/testing). |
| `CHAIN_ID` | var | Informational only. |
| `PINATA_JWT` | secret | Pinata JWT used to sign upload URLs. Needs the **Files: Write** scope only. |
| `PINATA_NETWORK` | var | `public` or `private`. |
| `PINATA_URL_EXPIRES` | var | Seconds the upload URL stays valid. |
| `PINATA_MAX_FILE_SIZE` | var | Optional max upload size in bytes. |
| `PINATA_ALLOW_MIME_TYPES` | var | Optional CSV of allowed MIME types. |
| `ALLOWED_ORIGIN` | var | Browser CORS: `*` or a comma-separated allowlist. Does not affect CLI/server callers. |

The condition is: `f(<returned uint256/bool>) COMPARE_OP COMPARE_VALUE`.
Only the **first 32-byte return word** is read, so the view function should
return a single `uint256` or `bool`.

Set `STUB_CONTRACT_CALL="true"` to skip this step entirely: the worker verifies
the ownership signature and then returns a presigned URL without any `eth_call`
(so `RPC_URL` isn't needed). The `200` response carries `stubbed: true`. Use it
for local dev or to exercise the signature flow; keep it off in production.

### Examples

- **Holds ≥ 1 NFT** (`balanceOf(address)`): `VIEW_SELECTOR=0x70a08231`,
  `PASS_ADDRESS_ARG=true`, `COMPARE_OP=gte`, `COMPARE_VALUE=1`.
- **Holds ≥ 10 USDC** (6 decimals): same selector, `COMPARE_VALUE=10000000`.
- **Custom `hasAccess(address) → bool`**: `VIEW_SELECTOR=`(that selector),
  `PASS_ADDRESS_ARG=true`, `COMPARE_OP=bool`.
- **Global flag `isOpen() → bool`, no arg**: `PASS_ADDRESS_ARG=false`,
  `COMPARE_OP=bool`.

## Responses

| Status | Body |
| --- | --- |
| `200` | `{ ok: true, address, uploadUrl, network, expiresIn }` |
| `401` | `{ ok: false, address, error, challenge }` — missing/invalid ownership signature; sign `challenge` and retry |
| `403` | `{ ok: false, address, error: "On-chain condition not met." }` |
| `400` | invalid/missing address |
| `502` | RPC or Pinata call failed (see `detail`) |

## Uploading with the returned URL

```js
const { uploadUrl, network } = await fetch(
  `https://<worker>/?address=${address}`,
).then((r) => r.json());

const fd = new FormData();
fd.append('file', file);          // a File/Blob
fd.append('network', network);    // must match the signed URL's network
const pin = await fetch(uploadUrl, { method: 'POST', body: fd }).then((r) => r.json());
// pin.data.cid → the IPFS CID
```

## Proving address ownership

The on-chain check alone only proves that **an address** meets the condition —
not that the caller controls it. To close that gap the worker **always** requires
the caller to **sign a challenge** with the address's private key and verifies
the signature (EIP-191 `personal_sign`) in `verifyCallerOwnsAddress()`
(`src/index.js`), recovering the signer with viem's `recoverMessageAddress`.

### The handshake

1. Caller requests without a signature and gets back the exact message to sign:

   ```
   POST / { "address": "0x…" }
   → 401 { ok:false, error:"Signature required…", challenge:"Fangorn onchain-gate…\nIssued-At: <unix>" }
   ```

2. Caller signs `challenge` with the address's key and resends:

   ```
   POST / { "address":"0x…", "message":"<challenge verbatim>", "signature":"0x…65 bytes" }
   → 200 { ok:true, uploadUrl, … }
   ```

The worker requires the signed `message` to be the canonical challenge verbatim,
its `Issued-At` to be within `SIGNATURE_MAX_AGE` seconds (default 300, bounding
replay without server-side state), and the recovered signer to equal `address`.

| Var | Where | Meaning |
| --- | --- | --- |
| `SIGNATURE_MAX_AGE` | var | Max age in seconds of the challenge's `Issued-At`. |

### Try it

A runnable simulated caller lives in [`examples/`](examples/):

```bash
pnpm dev                                      # terminal 1
node examples/simulated-caller.mjs            # terminal 2
```

It performs the full handshake (request → sign → resend) end to end. See
[`examples/README.md`](examples/README.md).
