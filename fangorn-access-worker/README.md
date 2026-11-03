# Fangorn access worker

The key server for paid fields (`field-v1`). It stores nothing: ciphertext is on IPFS, and the repo key arrives with each request inside the repo's `@deposit` record, sealed to this worker.

| route | does |
|---|---|
| `GET /pubkey` | the X25519 key publishers seal `@deposit` records to |
| `POST /access` | a signed `AccessRequest` (see the SDK's `buildAccessRequest`) → `{ sealed }`, the record key sealed to the buyer's throwaway key |

`/access` releases a key when the signer is the publisher, or when the SettlementRegistry's `canRead(reader, publisher, repo, key)` is true (settled for the record or the whole repo, and not taken down). The logic is in `src/access.ts`; `src/index.ts` is the HTTP routes.

## Configure

```sh
openssl rand -hex 32 | npx wrangler secret put WORKER_X25519_SECRET
```

Keep a copy of that secret. Every deposit is sealed to it, so losing it makes every paid repo unopenable, and changing it does the same.

Optional vars: `RPC_URL`, `SETTLEMENT_REGISTRY`. The defaults come from the SDK's Base Sepolia config.

## Develop

```sh
pnpm test        # vitest in workerd
pnpm typecheck
npx wrangler deploy
```

The SDK is linked from `../../fangorn` until the new version is published. Run `pnpm build` there after changing it.
