# Fangorn access worker


``` sh
cd ~/fangorn/webworker/fangorn-access-worker && pnpm deploy
node -e 'import("viem").then(({keccak256,stringToBytes:s})=>console.log(keccak256(s(`sond3r:upload-token:${process.env.K}`))))' # K=<ETH_PRIVATE_KEY>

node -e 'import("viem").then(({keccak256,stringToBytes:s})=>console.log(keccak256(s
(`sond3r:upload-token:0xde0e6c1c331fcd8692463d6ffcf20f9f2e1847264f7a3f578cf54f62f05196cb`))))'
# K=<ETH_PRIVATE_KEY>
npx wrangler secret put UPLOAD_HMAC_SECRET      # ← that value
openssl rand -hex 32 | npx wrangler secret put WORKER_X25519_SECRET
# then WORKER_URL=https://fangorn-access-worker.<subdomain>.workers.dev ./deploy.sh

Pin WORKER_X25519_SECRET before anyone publishes — unset, the worker mints a key into the bucket it protects.
```

A Cloudflare Worker that releases decryption keys against on-chain settlement.
**Publishers deploy their own** — one worker per R2 bucket — so the content sits
in their Cloudflare account, on their bill, under their own terms with
Cloudflare. Nobody else can read it, and nobody else is responsible for it.

Reference deployment: `https://fangorn-access-worker.quickbeam.workers.dev`

## Deploy your own

1. Consumer signs `{ nullifier, resourceId, objectKey, timestamp }` with their stealth address private key
2. Worker recovers the stealth address from the signature
3. Worker calls `getPrice(resourceId)` and, unless the resource is free, `isSettled(stealthAddress, resourceId)` on the SettlementRegistry
4. If settled → bytes proxied directly from R2
5. If not → 401
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fangorn-network/webworker/tree/main/fangorn-access-worker)

That is the whole setup. Cloudflare reads `wrangler.toml`, creates the R2 bucket
and the Worker in **your** account, and hands you a `*.workers.dev` URL. Paste
that URL into SOND3R's publisher portal ("connect your storage") and publish.

The `/tree/main/fangorn-access-worker` suffix is required — this repo is a pnpm
workspace, and a button pointed at the root fails with *"application detection
logic has been run in the root of a workspace"*.

## Configuration

**The SettlementRegistry address and the RPC endpoint come from
`@fangorn-network/sdk`** (`FangornConfig`), not from `wrangler.toml`. The SDK is the
only thing that knows which contracts belong to the current deployment, and checking a
retired registry answers `isSettled: false` for every buyer who paid on the live one —
a silent 401 with nothing in the logs to explain it. **Move deployments by bumping the
SDK, then redeploying.** The same is true of the storage and Quickbeam workers, so all
three follow one source.

| Var | Meaning |
|---|---|
| `SETTLEMENT_REGISTRY_ADDRESS` | **Normally unset.** Overrides the SDK's address, for repointing ahead of an SDK publish; taking it logs a warning naming what it replaced, and a malformed one fails the check rather than falling back to the SDK's |
| `ARBITRUM_SEPOLIA_RPC` | Optional. Default: the SDK's `FangornConfig.rpcUrl` |
| `TIMESTAMP_WINDOW` | Seconds a signed request stays valid (default `60`) |

Only `lib/config.js` is imported from the SDK — that module pulls in nothing but
viem, while the package root reaches node `fs`/`path` and the graph engine, which a
workerd bundle can't carry.

Re-run `npx wrangler types` after changing `wrangler.toml`.

## Run locally
There is nothing to configure, because the two things that would normally need
configuring configure themselves:

- **`UPLOAD_HMAC_SECRET`** — REQUIRED. Without it the worker authorizes nobody
  and every upload 401s, deliberately: it would otherwise be an open write
  endpoint on a bucket you pay for. It must equal the relay's own
  `keccak256(utf8("sond3r:upload-token:" + ETH_PRIVATE_KEY))`.
- **`WORKER_X25519_SECRET`** — 32 bytes of hex, the key every DEK in the bucket
  is sealed to. Unset, the worker mints one *into the bucket it protects*, so pin
  it and keep a copy: losing it strands every resource ever published here.

## Test

npm test    # vitest via @cloudflare/vitest-pool-workers

Two cases, both on the gate: that a read is checked against the SDK's
SettlementRegistry when nothing is configured, and that a malformed override fails
instead of silently falling back.

## Deploy
Prefer the CLI:

```sh
npx wrangler login
npx wrangler deploy
```

Both paths create a bucket named `fttf` (the `[[r2_buckets]]` binding in
`wrangler.toml`) — rename it there before your first deploy if you care what it
is called. Renaming it *after* publishing points the worker at an empty bucket.

## What it does

Files are AES-256-GCM encrypted by the publisher under a random per-file key
(the DEK). The ciphertext goes to R2; the DEK is sealed to this worker's X25519
public key and stored beside it. **The worker never sees plaintext** — it hands
back a 32-byte key to callers who have paid, and the decryption happens on the
buyer's machine.

| route                | gated?  | does                                                 |
| -------------------- | ------- | ---------------------------------------------------- |
| `GET /pubkey`        | no      | the X25519 key publishers seal DEKs to               |
| `GET /ct/:id`        | no      | streams ciphertext, with HTTP Range support          |
| `POST /access`       | **yes** | checks settlement, unseals the DEK, returns 32 bytes |
| `GET /upload/:id`    | **yes** | reads an object back (a publisher's own manifest)    |
| `POST /upload/:id`   | **yes** | stores ciphertext + sealed DEK                       |
| `DELETE /upload/:id` | **yes** | drops an object and its sealed DEK                   |

`/ct/` is deliberately open: ciphertext is safe to hand to anyone, and leaving it
ungated is what lets a video stream with ordinary Range requests. Only keys are
gated.

**Free tier.** The relay mints an upload token for *any* signed-in address, so
holding a token no longer means anyone vouched for the bearer — this worker is
what bounds the bill. Each owner gets `FREE_BYTES` (a `[vars]` entry, 50 MiB by
default), metered in `usage/<owner>` beside the bytes it counts and credited back
on delete. Over the cap, `POST /upload` answers `413 {"reason":"quota"}`.

`/access` releases a DEK when the request is signed, within `TIMESTAMP_WINDOW`
seconds, by a stealth address the registry says has settled. In order:

1. **The resource must exist** (`getOwner != 0`). An unregistered id reads back a
   price of 0, so checking the price first would treat every id the registry has
   never heard of as free.
2. **It must not be disabled** (`isDisabled`). This check exists here because it
   exists nowhere else: the registry leaves `isSettled` true after a takedown —
   the payment is a historical fact — so a taken-down resource is refused by this
   worker or by no one, including buyers who already paid.
3. **It must be settled** (`isSettled(stealthAddress, resourceId)`), unless it is
   priced at 0, which releases to any valid signer.

Object keys must be bytes32 — `resourceId` for chunk 0,
`keccak256(resourceId ++ uint32 i)` for the rest. Anything else 404s, which is
what keeps `/ct/` from serving the bucket's own `.dek` blobs and worker secret.

## One bucket, many publishers

The `/upload/` routes are gated on a token that **names its bearer**:

```
Authorization: Bearer <owner>.<keccak256(UPLOAD_HMAC_SECRET ++ owner)>
```

The relay derives it from its service key (`uploadTokenFor` in sond3r's
`server/index.js`); this worker recomputes the MAC (`macFor`) and reads the owner
address straight out of the token. No bucket state, no round trip, nothing to
claim — a publisher who has never touched this worker can upload immediately, and
the same wallet derives the same token from any machine. That is what replaced the
old first-upload-claims-the-bucket gate, which could only ever hold one publisher.

Object keys are already namespaced per publisher (`resourceIdFor(owner, uid)`,
`manifestKey(owner)`), so accidental collisions are impossible. Deliberate ones
are not — uids are public, so any publisher can compute another's `resourceId`.
So the owner is stamped on every object as R2 custom metadata and re-checked on
every write, delete and read-back:

| status | means                                                                |
| ------ | -------------------------------------------------------------------- |
| `401`  | no token, or a MAC that does not verify against `UPLOAD_HMAC_SECRET` |
| `403`  | a valid token, but this object belongs to another publisher          |

First writer keeps the key. An existing object with **no** owner recorded is
refused rather than adopted — it predates the shared bucket and there is nobody to
attribute it to.

**Rotating the relay's key** re-derives every token at once; update
`UPLOAD_HMAC_SECRET` here in the same breath and publishers do nothing. Nothing
else in the bucket is touched by any of this: ciphertext, sealed DEKs and the
X25519 identity all survive, so already-published files keep working.

**Bring your own storage** — a publisher deploying this into their own Cloudflare
account, with the bucket claiming its own token on first upload — is gone for now
and will come back as an option. It is in git, along with sond3r's
`server/cloudflare.js`.

## Develop

```sh
npx wrangler dev --local     # http://localhost:8787 — SOND3R accepts loopback http
npm test                     # vitest against a simulated R2
npm run typecheck
```

## Trust

Within the trust model this worker still sits inside it: it holds the key that
unseals your DEKs, so whoever runs the worker can read the content. Deploying
your own is what makes that "you" instead of someone else. Removing the boundary
entirely — moving the DEK into an FHE coprocessor so no operator holds it — is
Phase 1, and the handle format is already shaped for it.

Cloudflare itself remains trusted. Workers isolate at the V8 level rather than in
containers ([isolates](https://blog.cloudflare.com/introducing-cloudflare-workers/),
[Spectre mitigation](https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/)),
and the runtime is patched for you — but the operator can see what the isolate
sees.
