# Fangorn Webworker

A pnpm workspace containing the Cloudflare Workers behind Fangorn's content gating.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| [`fangorn-access-worker`](./fangorn-access-worker) | `fangorn-access-worker/` | Gates R2 content behind on-chain settlement verification. One worker per R2 bucket. |
| [`pinata-url-provider`](./pinata-url-provider) | `pinata-url-provider/` | Generic on-chain condition gate that mints Pinata presigned upload URLs for callers who prove address ownership and pass a configurable contract check. |

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
pnpm deploy:r2     # deploy fangorn-access-worker
pnpm deploy:gate   # deploy pinata-url-provider
pnpm typecheck     # typecheck every package that defines a typecheck script
```

Or work inside a package directly, e.g.:

```sh
pnpm --filter ./pinata-url-provider dev
```
