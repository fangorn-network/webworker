#!/usr/bin/env bash

set -euo pipefail

# ==============================================================================
# Deploys the Fangorn Cloudflare Workers — any one, any combination, or all.
#
#   storage    pinata-url-provider     presigned Pinata upload URLs under daily quotas;
#                                      deploys as pinata-url-provider-base
#   access     fangorn-access-worker   the key server: releases a paid field's key once
#                                      the SettlementRegistry says the reader paid
#   barliman   barliman                the relay and x402 facilitator: sends signed commits,
#                                      register and settle, paying gas from the treasury
#
# Usage:
#   ./deploy.sh                        # interactive: y/N per worker
#   ./deploy.sh all                    # every worker
#   ./deploy.sh access barliman        # any subset, any order
#   ./deploy.sh --dry-run all          # bundle + config check, deploy nothing
#   TARGETS="storage access" ./deploy.sh   # non-interactive preset (CI)
#
# Package directory names work as arguments too, so tab-completion is enough.
#
# Every worker reads its contract addresses from @fangorn-network/sdk, so the
# preflight prints what each package resolves and refuses to deploy a set whose SDK
# versions disagree — that mismatch is invisible at runtime and would gate each
# worker on a different deployment. It also checks each worker's own wiring:
# Barliman's TREASURY var and TREASURY_KEY secret, the key server's
# WORKER_X25519_SECRET, and prints the key server URL the SDK deposits with.
#
# `wrangler login` once first. The storage worker also needs its Pinata secret
# (`wrangler secret put PINATA_JWT`), set separately and unaffected by deploys.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORKERS=(storage access barliman)

# Short name or package directory → short name. The only place names are spelled.
canonical() {
    case "$1" in
        storage|pinata-url-provider)    echo storage ;;
        access|fangorn-access-worker)   echo access ;;
        barliman|relay)                 echo barliman ;;
        *) return 1 ;;
    esac
}

dir_for() {
    case "$1" in
        storage)   echo pinata-url-provider ;;
        access)    echo fangorn-access-worker ;;
        barliman)  echo barliman ;;
    esac
}

DRY_RUN=false
selected=()

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true; continue ;;
        -h|--help) sed -n '/^# =\{10,\}/,/^# =\{10,\}/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//; /^=\{10,\}/d'; exit 0 ;;
        all)       selected=("${WORKERS[@]}"); continue ;;
    esac
    # A typo that silently deploys nothing is worse than a failure.
    name=$(canonical "$arg") || { echo "Unknown worker: $arg (want: ${WORKERS[*]}, or all)" >&2; exit 1; }
    selected+=("$name")
done

# TARGETS= preset, then interactive — in that order of precedence.
if [[ ${#selected[@]} -eq 0 && -n "${TARGETS:-}" ]]; then
    for t in $TARGETS; do
        name=$(canonical "$t") || { echo "Unknown worker in TARGETS: $t" >&2; exit 1; }
        selected+=("$name")
    done
fi

if [[ ${#selected[@]} -eq 0 ]]; then
    echo "Which workers? (y/N each)" >&2
    for w in "${WORKERS[@]}"; do
        read -rp "  $w ($(dir_for "$w"))? " reply
        [[ "$reply" =~ ^[Yy] ]] && selected+=("$w")
    done
fi

# Dedupe into a stable order, so `./deploy.sh all storage` deploys each once.
deploy_list=()
for w in "${WORKERS[@]}"; do
    [[ " ${selected[*]-} " == *" $w "* ]] && deploy_list+=("$w")
done

if [[ ${#deploy_list[@]} -eq 0 ]]; then
    echo "Nothing selected." >&2
    exit 0
fi

# ── Preflight: can this login deploy these workers at all? ───────────────────
# wrangler caches the chosen Cloudflare account per package in
# node_modules/.cache/wrangler. A cache left over from a different account fails
# mid-deploy with an opaque `Authentication error [code: 10000]`, so check it up
# front against the accounts the current login can actually reach.
first_dir="$SCRIPT_DIR/$(dir_for "${deploy_list[0]}")"
accounts=$(cd "$first_dir" && pnpm exec wrangler whoami 2>/dev/null | grep -oE '\b[0-9a-f]{32}\b' | sort -u) || true
for w in "${deploy_list[@]}"; do
    cache="$SCRIPT_DIR/$(dir_for "$w")/node_modules/.cache/wrangler/wrangler-account.json"
    [[ -f "$cache" && -n "$accounts" ]] || continue
    pinned=$(grep -oE '[0-9a-f]{32}' "$cache" | head -1)
    grep -qx "$pinned" <<<"$accounts" && continue
    echo "$w is pinned to Cloudflare account $pinned, which this login cannot reach." >&2
    echo "  Log in with that account (wrangler logout && wrangler login), or, to deploy" >&2
    echo "  it somewhere else: rm -rf $(dir_for "$w")/node_modules/.cache/wrangler" >&2
    exit 1
done

# ── Preflight: which deployment is each package about to ship? ────────────────
# The addresses no longer live in wrangler.toml, so this is the only place an
# operator sees them before the fact.
echo >&2
echo "Deploying from @fangorn-network/sdk:" >&2
versions=()
for w in "${deploy_list[@]}"; do
    # The storage worker is gated on Base Sepolia; the others still on the SDK default.
    case "$w" in
        storage) config=BaseSepoliaConfig ;;
        *)       config=FangornConfig ;;
    esac
    info=$(cd "$SCRIPT_DIR/$(dir_for "$w")" && CONFIG=$config node --input-type=module -e '
        import { createRequire } from "node:module";
        const require = createRequire(process.cwd() + "/");
        const { version } = require("@fangorn-network/sdk/package.json");
        const c = (await import("@fangorn-network/sdk/lib/config.js"))[process.env.CONFIG];
        console.log(version, c.dataRegistryContractAddress, c.settlementRegistryContractAddress, c.keyServer ?? "unset");
    ') || { echo "  $w: cannot read the SDK — run pnpm install" >&2; exit 1; }
    read -r version data settlement keyserver <<<"$info"
    versions+=("$version")
    case "$w" in
        access)   gate="settlement $settlement" ;;
        barliman) gate="data $data, settlement $settlement" ;;
        *)        gate="data $data" ;;
    esac
    printf '  %-10s sdk %-16s %-18s %s\n' "$w" "$version" "$config" "$gate" >&2
done

echo "  the SDK deposits paid repos with key server: $keyserver" >&2

# ── Preflight: each worker's own wiring ──────────────────────────────────────
# A worker missing a secret deploys fine and then fails every request it exists for.
has_secret() { (cd "$SCRIPT_DIR/$(dir_for "$1")" && pnpm exec wrangler secret list 2>/dev/null) | grep -q "\"$2\""; }
for w in "${deploy_list[@]}"; do
    case "$w" in
        barliman)
            treasury=$(grep -E '^\s*TREASURY\s*=' "$SCRIPT_DIR/barliman/wrangler.toml" | grep -oE '0x[0-9a-fA-F]{40}' || true)
            if [[ -z "$treasury" || "$treasury" =~ ^0x0+$ ]]; then
                echo "barliman: set TREASURY (the referrer on every register) under [vars] in barliman/wrangler.toml" >&2
                exit 1
            fi
            echo "  barliman  referrer $treasury" >&2
            $DRY_RUN || has_secret barliman TREASURY_KEY \
                || echo "  ⚠ barliman has no TREASURY_KEY secret yet: wrangler secret put TREASURY_KEY (fund it with ETH)" >&2 ;;
        access)
            $DRY_RUN || has_secret access WORKER_X25519_SECRET \
                || echo "  ⚠ the key server has no WORKER_X25519_SECRET yet: openssl rand -hex 32 | wrangler secret put WORKER_X25519_SECRET" >&2 ;;
    esac
done

# One shared SDK is the whole point: different versions mean different contracts,
# and nothing at runtime would say so.
if [[ $(printf '%s\n' "${versions[@]}" | sort -u | wc -l) -gt 1 ]]; then
    echo "SDK versions disagree across these packages — align them before deploying." >&2
    exit 1
fi

# ── Deploy ────────────────────────────────────────────────────────────────────
for w in "${deploy_list[@]}"; do
    dir=$(dir_for "$w")
    echo >&2
    echo "==================================================" >&2
    echo "🚀 $w ($dir)$($DRY_RUN && echo ' — dry run')" >&2
    echo "==================================================" >&2
    if $DRY_RUN; then
        # Derive the real command from the package rather than assuming `wrangler
        # deploy`: the access worker deploys with `--env shared`, and a dry run of a
        # different config checks nothing. (`pnpm run deploy -- --dry-run` passes the
        # `--` through to wrangler, which ignores it and deploys for real.)
        (cd "$SCRIPT_DIR/$dir" \
            && pnpm exec $(node -p "require('./package.json').scripts.deploy") --dry-run)
    else
        (cd "$SCRIPT_DIR/$dir" && pnpm run deploy)
    fi
done

echo >&2
if $DRY_RUN; then
    echo "✅ dry run: ${deploy_list[*]} bundled, nothing deployed" >&2
else
    echo "✅ deployed: ${deploy_list[*]}" >&2
fi
