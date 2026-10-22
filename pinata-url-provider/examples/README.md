# examples

A simulated caller that proves address ownership to the `pinata-url-provider` worker.

## `simulated-caller.mjs`

Runs the full ownership handshake against a running worker:

1. `POST { address, appId }` → the worker replies `401` with a `challenge` to
   sign, naming the address and the app.
2. The caller signs the challenge with the address's private key
   (EIP-191 `personal_sign`).
3. `POST { address, appId, message, signature }` → the worker recovers the
   signer, confirms it matches `address`, then reads `access(appId, address)` on
   Base Sepolia and, if the app provides this wallet storage, returns a Pinata
   upload URL.

Signing uses [`viem`](https://viem.sh) (`privateKeyToAccount(...).signMessage`),
the same library the worker uses to recover the signer. Install deps first with
`pnpm install` (from the repo root).

### Run

```bash
# terminal 1 — start the worker (add PINATA_JWT to .dev.vars first if you want
# the resend to actually mint a Pinata URL; the access check uses the public
# Base Sepolia RPC by default)
pnpm dev

# terminal 2 — run the caller
APP_ID=my-app node examples/simulated-caller.mjs
# or point it elsewhere:
APP_ID=my-app node examples/simulated-caller.mjs https://pinata-url-provider-base.fangorn-0be.workers.dev
```

### Options

| Env | Default | Meaning |
| --- | --- | --- |
| `WORKER_URL` | `http://localhost:8787` | Worker base URL (or pass as the first CLI arg). |
| `PRIVATE_KEY` | built-in demo key | 0x-prefixed 32-byte secp256k1 key to sign with. |
| `APP_ID` | **required** | The app to upload for: an app name or a 32-byte hex id. The upload is billed to that app, and its owner must have accepted the caller. |

> The built-in demo key is a throwaway for demonstration only — **never fund its
> address or reuse the key**. Set `PRIVATE_KEY` to sign as a real address.

### Interpreting the result

- **`200`** — ownership proven **and** the app provides this wallet storage; you
  got an upload URL.
- **`403` / `402`** — the **signature was accepted** (ownership proven), but the
  app refused: `error` says why (not accepted by the app, suspended, banned, app
  unclaimed or taken down, or its subscription expired). The demo key is in no
  app: have an app's owner accept a real address (`fangorn app accept`), or sign
  as the owner.
- **`401`** — the ownership check rejected the request (no signature yet, or
  "Verification failed…" for a wrong key); the error explains which and includes a
  fresh `challenge`.
