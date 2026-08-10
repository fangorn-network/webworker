# Fangorn access worker

A Cloudflare Worker that releases decryption keys against on-chain settlement.
**Publishers deploy their own** — one worker per R2 bucket — so the content sits
in their Cloudflare account, on their bill, under their own terms with
Cloudflare. Nobody else can read it, and nobody else is responsible for it.

Reference deployment: `https://fangorn-access-worker.quickbeam.workers.dev`

## Deploy your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fangorn-network/webworker/tree/main/fangorn-access-worker)

That is the whole setup. Cloudflare reads `wrangler.toml`, creates the R2 bucket
and the Worker in **your** account, and hands you a `*.workers.dev` URL. Paste
that URL into SOND3R's publisher portal ("connect your storage") and publish.

The `/tree/main/fangorn-access-worker` suffix is required — this repo is a pnpm
workspace, and a button pointed at the root fails with *"application detection
logic has been run in the root of a workspace"*.

There is nothing to configure, because the two things that would normally need
configuring configure themselves:

- **The X25519 identity** is minted into your bucket on first request. It is the
  key every DEK in your bucket is sealed to, it never leaves your Cloudflare
  account, and it is generated once and kept.
- **The upload gate** claims itself. `POST /claim` stores the hash of an upload
  token plus the address of the wallet that signed for it, and every later upload
  must present that token. SOND3R does this the moment you connect the worker,
  and can rotate the token later against the same wallet — so losing the token
  never strands the bucket.

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

| route | gated? | does |
|---|---|---|
| `GET /pubkey` | no | the X25519 key publishers seal DEKs to |
| `GET /ct/:id` | no | streams ciphertext, with HTTP Range support |
| `POST /access` | **yes** | checks settlement, unseals the DEK, returns 32 bytes |
| `POST /upload/:id` | **yes** | stores ciphertext + sealed DEK |
| `POST /claim` | **yes** | claims (or rotates) the bucket's upload token |

`/ct/` is deliberately open: ciphertext is safe to hand to anyone, and leaving it
ungated is what lets a video stream with ordinary Range requests. Only keys are
gated.

`/access` releases a DEK when the request is signed by a stealth address for
which `SettlementRegistry.isSettled(stealthAddress, resourceId)` is true, within
`TIMESTAMP_WINDOW` seconds. Resources priced at 0 release to any valid signer.

Object keys must be bytes32 — `resourceId` for chunk 0,
`keccak256(resourceId ++ uint32 i)` for the rest. Anything else 404s, which is
what keeps `/ct/` from serving the bucket's own `.dek` blobs and worker secret.

## Taking back a claimed bucket

`POST /claim` with a token the bucket doesn't hold answers 401 and a `reason`:

| `reason` | means | fix |
|---|---|---|
| `needs-signature` | claimed by another token | sign the claim message with the owning wallet — retry Connect in the publisher portal, which prompts for it |
| `not-owner` | claimed, and owned by a different address | connect with the wallet named in the error |
| `pinned` | the worker has an `UPLOAD_TOKEN` secret, which overrides everything | paste that value into the portal's *Upload token* field, or `npx wrangler secret delete UPLOAD_TOKEN` |

The claim message is `sond3r storage claim\ntoken: <sha256 of token>\ntime:
<unix>`, valid for 10 minutes. The first claim records the signer as the bucket's
owner; only that address can point the bucket at a different token afterwards.
Nothing else in the bucket is touched — ciphertext, sealed DEKs and the X25519
identity all survive, so already-published files keep working.

A bucket claimed before this shipped has no recorded owner, so the first valid
signature adopts it. That is the migration path for buckets stranded by the old
token-only gate.

## Optional env

Both are for the shared deployment and neither is needed for your own:

| var | effect |
|---|---|
| `WORKER_X25519_SECRET` | pins the identity instead of minting one. **Required** on a worker that already has DEKs sealed to a key — minting a new one strands every published file. `openssl rand -hex 32 \| npx wrangler secret put WORKER_X25519_SECRET` |
| `UPLOAD_TOKEN` | pins the upload token instead of claiming on first use |

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
