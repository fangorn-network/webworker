# Fangorn Webworker

The Fangorn webworker is a Cloudflare Worker that gates R2 content behind on-chain settlement verification. Publishers deploy their own worker, with one worker per R2 bucket.

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