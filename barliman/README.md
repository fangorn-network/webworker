# Barliman

The relay (a gas-paying facilitator): it submits transactions that publishers and buyers
signed, and the treasury pays the gas.

| route | body | sends |
|---|---|---|
| `POST /relay/commit` | `{ publisher, update: { repo, epoch, parent, root, car }, signature }` | `DataRegistry.updateBySig` |
| `POST /relay/register` | `register`'s arguments without `referrer` (terms as in a record's `@terms`) | `SettlementRegistry.register`, referrer = `TREASURY` |
| `POST /relay/settle` | `settle`'s arguments | `SettlementRegistry.settle` |

Bigints are decimal strings. Each route returns `{ tx }`, or:
- 400 for a malformed body,
- 422 with the revert reason (for example `EpochOutOfWindow`, `StaleTerms`), sent nowhere,
- 429 past a daily limit.

Every call is simulated before it is sent, so a call that would revert costs nothing.

Daily limits, kept in KV (`RATE_KV`): 100 commits per publisher, and 20 free (`price == 0`)
registers per IP. Free registers are limited by IP because nothing in them is signed by a payer.
Paid registers and settles aren't limited.

## x402 facilitator

Barliman is an x402 (v2) facilitator for buying a record. The scheme is `fangorn`, and the payment is `register`: `POST /verify` simulates it and `POST /settle` sends it. `GET /supported` lists the scheme.

The seller's 402 (westmarch) names the record's signed terms:

```json
{ "scheme": "fangorn", "network": "eip155:84532", "amount": "<price>", "asset": "<USDC>",
  "payTo": "<SettlementRegistry>", "maxTimeoutSeconds": 300,
  "extra": { "terms": { … }, "signature": "0x…" } }
```

The buyer's `PaymentPayload.payload` is `{ commitment, salt, payment }`, where `payment` is the ERC-3009 `receiveWithAuthorization` to the registry. A retry after `register` already landed succeeds (`AlreadyRegistered` counts as paid). Free records don't go through x402; they use `/relay/register`.

After paying, the buyer sends its Semaphore proof to `/relay/settle`, then asks the key server for the key. Settle isn't part of x402, because the proof can only be made once `register` has landed.

Not yet: listing in a Bazaar (PayAI listed sellers in its own), and the `exact` scheme (passes and per-call MCP payments).

## Configure

```sh
npx wrangler secret put TREASURY_KEY     # pays gas; fund it with Base Sepolia ETH
```

Set `TREASURY` (the referrer address) under `[vars]` in `wrangler.toml`. The worker refuses requests without it. `RPC_URL` is optional.

## Develop

```sh
pnpm test
pnpm typecheck
npx wrangler deploy     # creates the RATE_KV namespace on first deploy
```
