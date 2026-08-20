#!/usr/bin/env bash

set -euo pipefail

# ==============================================================================
# Deploys the Fangorn Cloudflare Workers — any one, any combination, or all.
#
#   storage    pinata-url-provider     presigned Pinata upload URLs, gated on
#                                      access() at the SubscriptionRegistry
#   quickbeam  quickbeam-registry      Quickbeam view control plane, same gate
#   access     fangorn-access-worker   R2 reads gated on the SettlementRegistry
#
# Usage:
#   ./deploy.sh                        # interactive: y/N per worker
#   ./deploy.sh all                    # every worker
#   ./deploy.sh storage quickbeam      # any subset, any order
#   ./deploy.sh --dry-run all          # bundle + config check, deploy nothing
#   TARGETS="storage access" ./deploy.sh   # non-interactive preset (CI)
#
# Deploying `quickbeam` asks whether to clear its KV store (every view, and the
# per-view DNS rows) once the deploy lands. Default is no; CLEAR_KV=true|false
# answers it non-interactively.
#
# Package directory names work as arguments too, so tab-completion is enough.
#
# All three workers read their contract addresses from @fangorn-network/sdk, so
# the preflight prints what each package resolves and refuses to deploy a set
# whose SDK versions disagree — that mismatch is invisible at runtime and would
# gate each worker on a different deployment.
#
# `wrangler login` once first. The storage worker also needs its Pinata secret
# (`wrangler secret put PINATA_JWT`), set separately and unaffected by deploys.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORKERS=(storage quickbeam access)

# Short name or package directory → short name. The only place names are spelled.
canonical() {
    case "$1" in
        storage|pinata-url-provider)    echo storage ;;
        quickbeam|quickbeam-registry)   echo quickbeam ;;
        access|fangorn-access-worker)   echo access ;;
        *) return 1 ;;
    esac
}

dir_for() {
    case "$1" in
        storage)   echo pinata-url-provider ;;
        quickbeam) echo quickbeam-registry ;;
        access)    echo fangorn-access-worker ;;
    esac
}

DRY_RUN=false
selected=()

# Wipe every key in the Quickbeam worker's KV: the `view:` rows and their `dns:`
# reverse-map entries, which is everything it stores. Asked, never assumed.
#
# ponytail: a raw KV wipe, so a view's hosted Cloud Run MCP outlives its row — the
# worker's own /admin/remove deletes that service first, this cannot. Remove hosted
# views with examples/manage-views.mjs --remove before clearing, or delete the
# services by hand afterwards.
clear_quickbeam_kv() {
    local dir="$SCRIPT_DIR/$(dir_for quickbeam)"
    local keys count file
    keys=$(cd "$dir" && pnpm exec wrangler kv key list --binding QUICKBEAM_KV --remote 2>/dev/null) \
        || { echo "  ✘ could not list the KV namespace — nothing cleared" >&2; return 1; }
    count=$(grep -c '"name"' <<<"$keys" || true)

    if [[ "$count" -eq 0 ]]; then
        echo "  KV is already empty." >&2
        return 0
    fi

    if [[ -n "${CLEAR_KV:-}" ]]; then
        [[ "$CLEAR_KV" == true ]] || { echo "  KV left alone (CLEAR_KV=$CLEAR_KV): $count key(s)." >&2; return 0; }
    elif [[ ! -t 0 ]]; then
        echo "  KV left alone ($count key(s)) — no TTY to ask; set CLEAR_KV=true to wipe." >&2
        return 0
    else
        echo >&2
        echo "  The Quickbeam KV holds $count key(s) — every view and its DNS row." >&2
        echo "  Hosted Cloud Run MCP services are NOT deleted by this wipe." >&2
        read -rp "  Clear the KV store? [y/N] " reply
        [[ "$reply" =~ ^[Yy] ]] || { echo "  Left alone." >&2; return 0; }
    fi

    # wrangler kv bulk delete wants a JSON array of key names.
    file=$(mktemp); trap 'rm -f "$file"' RETURN
    grep -oE '"name": "[^"]+"' <<<"$keys" | sed 's/"name": //' | paste -sd, - | sed 's/^/[/; s/$/]/' > "$file"
    (cd "$dir" && pnpm exec wrangler kv bulk delete "$file" --binding QUICKBEAM_KV --remote --force)
    echo "  🗑  cleared $count key(s)." >&2
}

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
    info=$(cd "$SCRIPT_DIR/$(dir_for "$w")" && node --input-type=module -e '
        import { createRequire } from "node:module";
        const require = createRequire(process.cwd() + "/");
        const { version } = require("@fangorn-network/sdk/package.json");
        const { FangornConfig: c } = await import("@fangorn-network/sdk/lib/config.js");
        console.log(version, c.dataRegistryContractAddress, c.subscriptionRegistryContractAddress, c.settlementRegistryContractAddress);
    ') || { echo "  $w: cannot read the SDK — run pnpm install" >&2; exit 1; }
    read -r version data subscription settlement <<<"$info"
    versions+=("$version")
    case "$w" in
        access) gate="settlement $settlement" ;;
        *)      gate="subscription $subscription (data $data)" ;;
    esac
    printf '  %-10s sdk %-16s %s\n' "$w" "$version" "$gate" >&2
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
        [[ "$w" == quickbeam ]] && echo "  (would ask whether to clear the KV store)" >&2
    else
        (cd "$SCRIPT_DIR/$dir" && pnpm run deploy)
        # After the deploy, not before: a failed deploy should not cost you the store.
        [[ "$w" == quickbeam ]] && clear_quickbeam_kv
    fi
done

echo >&2
if $DRY_RUN; then
    echo "✅ dry run: ${deploy_list[*]} bundled, nothing deployed" >&2
else
    echo "✅ deployed: ${deploy_list[*]}" >&2
fi
