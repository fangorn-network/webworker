# pinata-url-provider

A tiny, self-contained Cloudflare Worker that gates a **Pinata presigned upload
URL** behind **on-chain registration**.

1. The caller proves control of an address by signing a one-time challenge. If the
   signature doesn't verify, the request is rejected ("Verification failed…").
2. The worker calls `isRegistered(address)` on the Fangorn registry contract (a
   Stylus contract on Arbitrum Sepolia). If the address isn't registered, it tells
   the caller to register at fangorn.network.
3. If registered, the worker mints a short-lived Pinata presigned upload URL and
   returns it. The caller uploads one file to IPFS without ever seeing your JWT.

The only runtime dependency is [`viem`](https://viem.sh) (signature recovery +
selector encoding); everything else rides on the Workers `fetch` runtime. All
behaviour is configured through environment variables.

## Setup

This worker is one package in a pnpm workspace. Install once from the repo root,
then work inside this package:

```bash
pnpm install                       # from the repo root — installs viem + wrangler

cd pinata-url-provider
cp .dev.vars.example .dev.vars     # add your PINATA_JWT for local dev
```

Edit `wrangler.toml` `[vars]` to point at your registry, then run locally:

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

**3. Set the secret** (never put it in `wrangler.toml`):

```bash
pnpm exec wrangler secret put PINATA_JWT    # the Files:Write JWT from step 2
```

`RPC_URL` defaults to the public Arbitrum Sepolia endpoint in `wrangler.toml`, so
no RPC secret is required — override that var if you want a private endpoint.

**4. Configure the registry check** in `wrangler.toml` `[vars]`:

- `REGISTRY_CONTRACT_ADDRESS` — the contract the worker calls
  `isRegistered(address)` on (defaults to the Fangorn registry `0x0d3f…ab64` on
  Arbitrum Sepolia).
- `RPC_URL` — defaults to the public Arbitrum Sepolia RPC; swap in your own for
  higher rate limits.
- Keep `STUB_REGISTRATION_CHECK = "false"` in production. Setting it `"true"`
  skips the on-chain check — a valid signature alone yields a URL (dev only).
- `REGISTER_URL` — shown in the "not registered" error (default
  `https://fangorn.network`).
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
| `REGISTRY_CONTRACT_ADDRESS` | var | Registry contract; the worker calls `isRegistered(address)` on it. Default: the Fangorn registry on Arbitrum Sepolia. |
| `RPC_URL` | var | EVM JSON-RPC endpoint. Default: public Arbitrum Sepolia. |
| `REGISTRY_FUNCTION` | var | Optional. ABI signature of the check (default `isRegistered(address)`). |
| `STUB_REGISTRATION_CHECK` | var | `"true"` skips the on-chain check — a valid signature alone yields a URL (dev/testing). |
| `REGISTER_URL` | var | URL shown in the "not registered" error (default `https://fangorn.network`). |
| `CHAIN_ID` | var | Informational only (`421614` = Arbitrum Sepolia). |
| `PINATA_JWT` | secret | Pinata JWT used to sign upload URLs. Needs the **Files: Write** scope only. |
| `PINATA_NETWORK` | var | `public` or `private`. |
| `PINATA_URL_EXPIRES` | var | Seconds the upload URL stays valid. |
| `PINATA_MAX_FILE_SIZE` | var | Optional max upload size in bytes. |
| `PINATA_ALLOW_MIME_TYPES` | var | Optional CSV of allowed MIME types. |
| `ALLOWED_ORIGIN` | var | Browser CORS: `*` or a comma-separated allowlist. Does not affect CLI/server callers. |

The worker calls `isRegistered(address)` (a `view` returning `bool`) on
`REGISTRY_CONTRACT_ADDRESS` and gates on the result. Note the Fangorn registry is
a **Stylus** (Rust) contract whose `is_registered` method is exposed in the ABI as
camelCase **`isRegistered(address)`** — that is the default; override
`REGISTRY_FUNCTION` only if your registry differs.

Set `STUB_REGISTRATION_CHECK="true"` to skip this step entirely: the worker
verifies the ownership signature and then returns a presigned URL without any
`eth_call` (so no RPC is needed). The `200` response carries `stubbed: true`. Use
it for local dev or to exercise the signature flow; keep it off in production.

## Responses

| Status | Body |
| --- | --- |
| `200` | `{ ok: true, address, uploadUrl, network, expiresIn }` |
| `401` | `{ ok: false, address, error, challenge }` — no signature yet, or verification failed ("…correct private key"); sign `challenge` and retry |
| `403` | `{ ok: false, address, error: "This public key is not registered…" }` — ownership proven, but the address isn't registered |
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
   POST / { "address":"0x…", "message":"<challenge verbatim>", "signature":"0x…65 bytes" }
   → 200 { ok:true, uploadUrl, … }   (or 403 if that address isn't registered)
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
