# Fangorn Webworker

A pnpm workspace containing the Cloudflare Workers behind Fangorn's content gating.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| [`fangorn-access-worker`](./fangorn-r2) | `fangorn-r2/` | Gates R2 content behind on-chain settlement verification. One worker per R2 bucket. |
| [`onchain-gate`](./onchain-gate) | `onchain-gate/` | Generic on-chain condition gate that mints Pinata presigned upload URLs for callers who prove address ownership and pass a configurable contract check. |

See each package's own `README.md` for details.

## Getting started

This repo uses [pnpm](https://pnpm.io) workspaces.

```sh
pnpm install
```

## Common tasks

Run from the repo root:

```sh
pnpm dev:r2        # wrangler dev for fangorn-r2
pnpm dev:gate      # wrangler dev for onchain-gate
pnpm deploy:r2     # deploy fangorn-r2
pnpm deploy:gate   # deploy onchain-gate
pnpm typecheck     # typecheck every package that defines a typecheck script
```

Or work inside a package directly, e.g.:

```sh
pnpm --filter ./onchain-gate dev
```
