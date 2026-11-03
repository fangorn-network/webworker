# Fangorn Webworker

The Cloudflare Workers Fangorn runs for its testnet on Base Sepolia. Each holds one secret,
deploys on its own, and calls none of the others.

| Worker | Package | Does | Secret |
|---|---|---|---|
| Storage | [`pinata-url-provider`](./pinata-url-provider) | Mints Pinata presigned upload URLs for wallets that prove ownership, under daily quotas | `PINATA_JWT` |
| Key server | [`fangorn-access-worker`](./fangorn-access-worker) | Releases a paid field's key once the SettlementRegistry says the reader paid. Stores nothing | `WORKER_X25519_SECRET` |
| Barliman | [`barliman`](./barliman) | The relay and x402 facilitator: sends signed commits, `register` and `settle`, paying gas from the treasury | `TREASURY_KEY` |

`quickbeam-registry` is also in the workspace; it predates the current design and isn't covered here.

None of these is part of the protocol. The chain and IPFS are the source of truth, and each worker
can be replaced: a publisher can run their own key server (and name it in their deposit), anyone
with ETH can call `register` and `settle` themselves, and any IPFS pinning service stores records.

## How a sale uses them

1. The publisher seals a record's fields and signs its price (`fangorn commit --paid`). The repo's
   key goes into a `@deposit` record, sealed to the key server. Uploads go through the storage worker.
2. An app (a [westmarch](https://github.com/fangorn-network/westmarch) Worker) quotes the record over
   x402 v2, scheme `fangorn`. Barliman's `/verify` and `/settle` send the buyer's `register`, which
   pays the publisher and gives the treasury its referral share.
3. The buyer proves with Semaphore that it paid, naming a reading address, and Barliman sends that
   `settle`.
4. The buyer asks the key server for the record's key, signing as the reading address.

## Develop

This is a pnpm workspace.

```sh
pnpm install
pnpm --filter ./barliman test     # each package: test, typecheck, dev
pnpm typecheck                     # every package
```

Every package takes its contract addresses and RPC from `@fangorn-network/sdk`. The key server and
Barliman also take `RPC_URL`, `SETTLEMENT_REGISTRY` (and Barliman `DATA_REGISTRY`) as overrides,
which is how they run against a local chain.

### Running them together

westmarch drives these packages from a sibling checkout (`FANGORN_WEBWORKER_DIR`, default
`../webworker`), each under `wrangler dev`:

```sh
cd ../westmarch
npm run e2e:paid                    # anvil + contracts, key server, Barliman, an app: one sale, mocked USDC and proof
node scripts/sale-live.mjs          # one real sale on Base Sepolia (real USDC and proof); see the file for its keys
npx westmarch-ship app.json --devnet   # a whole app locally; with "paid", the key server and Barliman too
```

## Deploy

`./deploy.sh` deploys any one worker, any combination, or all of them:

```sh
./deploy.sh                        # interactive: y/N per worker
./deploy.sh access barliman        # names: storage, quickbeam, access, barliman
./deploy.sh --dry-run all          # bundle and check, deploy nothing
TARGETS="access barliman" ./deploy.sh
```

Before deploying it prints the SDK version and the contracts each package resolves, and refuses a
set whose SDK versions disagree. It also checks each worker's wiring: Barliman needs `TREASURY`
under `[vars]` in its `wrangler.toml` (refused without it) and a `TREASURY_KEY` secret; the key
server needs `WORKER_X25519_SECRET` (warned when missing). It prints the key server URL the SDK
deposits paid repos with.

Secrets are set once per worker, and deploys leave them alone:

```sh
cd fangorn-access-worker && openssl rand -hex 32 | npx wrangler secret put WORKER_X25519_SECRET
cd barliman && npx wrangler secret put TREASURY_KEY      # fund its address with Base Sepolia ETH
cd pinata-url-provider && npx wrangler secret put PINATA_JWT
```

Keep a copy of `WORKER_X25519_SECRET`: every deposit is sealed to it, and losing or changing it
makes every paid repo deposited with this key server unopenable. A deposit also names the key
server's URL for good, so serve it from a domain you control before anyone publishes.

**Move deployments by bumping `@fangorn-network/sdk`, then redeploying.** Only
`@fangorn-network/sdk/lib/…` modules are imported: they pull in viem and noble, nothing a workerd
bundle can't carry.

## Security

Workers run in V8 isolates on Cloudflare, which is trusted: the operator can see what an isolate
sees. That matters most for the key server, which could unseal any deposit made to it. A publisher
who won't accept that runs their own.
