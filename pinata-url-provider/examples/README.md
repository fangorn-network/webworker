# examples

A simulated caller that proves address ownership to the `pinata-url-provider` worker.

## `simulated-caller.mjs`

Runs the full ownership handshake against a running worker:

1. `POST { address }` → the worker replies `401` with a `challenge` to sign.
2. The caller signs the challenge with the address's private key
   (EIP-191 `personal_sign`).
3. `POST { address, message, signature }` → the worker recovers the signer,
   confirms it matches `address`, then checks on-chain registration and (if
   registered) returns a Pinata upload URL.

Signing uses [`viem`](https://viem.sh) (`privateKeyToAccount(...).signMessage`),
the same library the worker uses to recover the signer. Install deps first with
`pnpm install` (from the repo root).

### Run

```bash
# terminal 1 — start the worker (add PINATA_JWT to .dev.vars first if you want
# the resend to actually mint a Pinata URL; the registry check uses the public
# Arbitrum Sepolia RPC by default)
pnpm dev

# terminal 2 — run the caller
node examples/simulated-caller.mjs
# or point it elsewhere:
node examples/simulated-caller.mjs https://pinata-url-provider.fangorn-0be.workers.dev
```

### Options

| Env | Default | Meaning |
| --- | --- | --- |
| `WORKER_URL` | `http://localhost:8787` | Worker base URL (or pass as the first CLI arg). |
| `PRIVATE_KEY` | built-in demo key | 0x-prefixed 32-byte secp256k1 key to sign with. |

> The built-in demo key is a throwaway for demonstration only — **never fund its
> address or reuse the key**. Set `PRIVATE_KEY` to sign as a real address.

### Interpreting the result

- **`200`** — ownership proven **and** the address is registered; you got an
  upload URL.
- **`403` "This public key is not registered…"** — the **signature was accepted**
  (ownership proven); the address just isn't registered. The demo key won't be —
  register a real address at fangorn.network, or set `STUB_REGISTRATION_CHECK=true`
  locally to bypass the check.
- **`401`** — the ownership check rejected the request (no signature yet, or
  "Verification failed…" for a wrong key); the error explains which and includes a
  fresh `challenge`.
