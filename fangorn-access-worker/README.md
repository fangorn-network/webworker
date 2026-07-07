# Fangorn Webworker

The Fangorn webworker is a Cloudflare Worker that gates R2 content behind on-chain settlement verification. Publishers deploy their own worker, with one worker per R2 bucket.

Example deployed at `https://fangorn-access-worker.quickbeam.workers.dev`

### How it works

1. Consumer signs `{ nullifier, resourceId, objectKey, timestamp }` with their stealth address private key
2. Worker recovers the stealth address from the signature
3. Worker calls `is_settled(stealthAddress, resourceId)` on the Settlement Registry
4. If settled → bytes proxied directly from R2
5. If not → 401

The worker is stateless, open-source, and has no logging. Its only capability is verifying settlement and proxying bytes. The content URL is never exposed to the consumer.


## Run locally

npx wrangler dev --local

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