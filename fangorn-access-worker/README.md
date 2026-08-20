# Fangorn Webworker

The Fangorn webworker is a Cloudflare Worker that gates R2 content behind on-chain settlement verification. Publishers deploy their own worker, with one worker per R2 bucket.

Example deployed at `https://fangorn-access-worker.quickbeam.workers.dev`

### How it works

1. Consumer signs `{ nullifier, resourceId, objectKey, timestamp }` with their stealth address private key
2. Worker recovers the stealth address from the signature
3. Worker calls `getPrice(resourceId)` and, unless the resource is free, `isSettled(stealthAddress, resourceId)` on the SettlementRegistry
4. If settled → bytes proxied directly from R2
5. If not → 401

The worker is stateless, open-source, and has no logging. Its only capability is verifying settlement and proxying bytes. The content URL is never exposed to the consumer.


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

npx wrangler dev --local

## Test

npm test    # vitest via @cloudflare/vitest-pool-workers

Two cases, both on the gate: that a read is checked against the SDK's
SettlementRegistry when nothing is configured, and that a malformed override fails
instead of silently falling back.

## Deploy

npx wrangler login

npx wrangler deploy

## Security

Cloudflare Webworkers are designed with a high-security isolation model. Instead of VMs or containers, they use V8 isolated, providing a lightweight and secure environment. However, they fundamentally require *trust in Cloudflare*. 

- V8 Isolates: Unlike containers that share an OS kernel, [V8 Isolates](https://blog.cloudflare.com/introducing-cloudflare-workers/) separate code at the memory level. This allows thousands of Workers to run on a single thread while remaining isolated.
- Spectre Mitigation: Cloudflare uses a unique approach to prevent [Spectre-style side-channel attacks](https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/) by removing high-precision timers and implementing memory protection keys that trap unauthorized memory access attempts.
- Automatic Patches: Since Cloudflare manages the runtime, security updates for the V8 engine and the Workers runtime are applied automatically without developer intervention. 

### Application-Level Security (Developer’s Responsibility)
While the infrastructure is hardened, developers must secure the logic and data flow within their scripts. 

    Secret Management: Never hardcode sensitive data like API keys. Use Wrangler Secrets to encrypt and store credentials securely.
    Authentication & Access: You can implement Cloudflare Access with a single click to protect Worker routes or use the Web Crypto API for custom JWT validation.
    Data Protection: Data stored in Workers KV is encrypted at rest using AES-256 and encrypted in transit via TLS.
    Security Headers: Workers are frequently used to inject security headers (e.g., CSP, HSTS, X-Frame-Options) into responses to protect against XSS and clickjacking. 