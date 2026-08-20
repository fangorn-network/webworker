# examples

## `manage-views.mjs`

Creates and removes Quickbeam views from the command line.

The worker's write routes require an EIP-191 `personal_sign` over a challenge it
builds, which curl cannot produce — so this runs the same two-step handshake the
website does:

1. `POST { address, … }` → the worker replies `401` with a `challenge`
2. the caller signs it with the address's key (viem's
   `privateKeyToAccount(...).signMessage`, the same library the worker recovers with)
3. `POST { address, message, signature, … }` → the worker verifies, checks the
   subscription, and acts

**The private key is only ever used locally to sign. It is never sent.**

### Create a view

```sh
node examples/manage-views.mjs --worker https://…workers.dev --key 0xKEY \
  --name my-view --source 0xOWNER:namespace
```

Repeat `--source` to span several namespaces in one view. Add `--hosted-mcp` to also
provision a Cloud Run MCP (needs the `GCP_*` vars — otherwise the view is created and
`mcpError` explains why the MCP was not).

### Read the watchlist

No key, no signature — it is a public read, and it is exactly what the instance polls:

```sh
node examples/manage-views.mjs --worker https://…workers.dev --watchlist
```

Two views over the same namespace list it **once**. That is the embed-once property.

### Remove a view

Requires a wallet in `ADMIN_WALLETS`:

```sh
node examples/manage-views.mjs --worker https://…workers.dev --key 0xADMINKEY \
  --remove qb_147c24c5_my-view
```

A source leaves the watchlist only when the **last** view referencing it goes.

### Exit codes and what they mean

The script exits non-zero on a refusal and names it:

| HTTP | Meaning |
|---|---|
| `202` / `200` | created / replaced, or removed |
| `402` | that wallet has no active subscription |
| `403` | not a registered publisher, or not an admin for `/admin/remove` |
| `401` | the signature did not verify — wrong key for that address |
| `429` | per-wallet view cap (`MAX_VIEWS_PER_WALLET`) |

### Against a local worker

```sh
npx wrangler dev --var STUB_GATE:true
node examples/manage-views.mjs --worker http://localhost:8787 --key 0xANYKEY \
  --name demo --source 0xOWNER:namespace
```

`STUB_GATE` skips the on-chain check, so any signing key works — useful for exercising
the routes before a wallet is registered or subscribed.
