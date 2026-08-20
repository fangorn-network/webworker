# Fangorn Webworker

A pnpm workspace containing the Cloudflare Workers behind Fangorn's content gating.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| [`fangorn-access-worker`](./fangorn-access-worker) | `fangorn-access-worker/` | Gates R2 content behind on-chain settlement verification. One worker per R2 bucket. |
| [`pinata-url-provider`](./pinata-url-provider) | `pinata-url-provider/` | Mints Pinata presigned upload URLs for callers who prove address ownership and pass the SubscriptionRegistry's `access()` check (registration + storage subscription). |
| [`quickbeam-registry`](./quickbeam-registry) | `quickbeam-registry/` | Control plane for Quickbeam views: KV of watched sources, the instance's `/watchlist`, and the per-view search/CDN proxy. Gated on the same storage subscription. |

See each package's own `README.md` for details.

## Getting started

This repo uses [pnpm](https://pnpm.io) workspaces.

```sh
pnpm install
```

## Common tasks

Run from the repo root:

```sh
pnpm dev:r2        # wrangler dev for fangorn-access-worker
pnpm dev:gate      # wrangler dev for pinata-url-provider
pnpm typecheck     # typecheck every package that defines a typecheck script
```

## Deploying

`./deploy.sh` deploys any one worker, any combination, or all of them:

```sh
./deploy.sh                      # interactive: y/N per worker
./deploy.sh all
./deploy.sh storage quickbeam    # names: storage, quickbeam, access
./deploy.sh --dry-run all        # bundle + config check, deploy nothing
TARGETS="storage access" ./deploy.sh    # non-interactive (CI)
```

Deploying `quickbeam` asks, after the deploy lands, whether to clear its KV store —
every view and its DNS row. Default is no; `CLEAR_KV=true|false` answers it
non-interactively. It is a raw wipe, so a view's hosted Cloud Run MCP outlives its row:
remove hosted views with `quickbeam-registry/examples/manage-views.mjs --remove` first,
or delete those services by hand afterwards.

Package directory names work as arguments too. Before deploying anything it prints
the SDK version and contract addresses each package resolves, and **refuses a set
whose SDK versions disagree** — that would gate each worker on a different deployment
with nothing at runtime to say so. `wrangler login` once first; the storage worker's
`PINATA_JWT` is a secret set separately and is unaffected by deploys.

Or work inside a package directly, e.g.:

```sh
pnpm --filter ./pinata-url-provider dev
```

`quickbeam-registry` has no root shortcut; run it the same way
(`pnpm --filter ./quickbeam-registry dev`).

## Contract addresses

All three workers take their registry addresses and RPC endpoint from
`@fangorn-network/sdk` (`FangornConfig`) — the storage and Quickbeam workers gate on
`access()` at the SubscriptionRegistry, the access worker checks the
SettlementRegistry. Nothing is pinned in a `wrangler.toml`: the SDK is the only thing
that knows which contracts belong together, and a worker left on a retired one fails
closed and silently — every wallet reads as unregistered, every buyer as unsettled.

**Move deployments by bumping `@fangorn-network/sdk`, then redeploying the workers.**
Each keeps an env override (`SUBSCRIPTION_CONTRACT_ADDRESS`,
`SETTLEMENT_REGISTRY_ADDRESS`) as an escape hatch for repointing ahead of an SDK
publish; taking one logs a warning naming what it replaced.

Only `@fangorn-network/sdk/lib/config.js` is imported — it pulls in nothing but viem,
while the package root reaches node `fs`/`path` and the graph engine, which a workerd
bundle can't carry.
