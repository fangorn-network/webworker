/**
 * Create and remove Quickbeam views from the command line.
 *
 * The worker's write routes need an EIP-191 `personal_sign` over a challenge it
 * builds, which curl cannot produce — so this runs the same two-step handshake the
 * website does:
 *
 *   1. POST { address, … }                       → 401 + a `challenge` to sign
 *   2. sign it with the address's key (viem, the same lib the worker recovers with)
 *   3. POST { address, message, signature, … }   → the worker verifies and acts
 *
 * Usage:
 *   node examples/manage-views.mjs --worker https://…workers.dev --key 0xKEY \
 *        --name my-view --source 0xOWNER:namespace [--source 0xOWNER:other] [--hosted-mcp]
 *
 *   node examples/manage-views.mjs --worker https://…workers.dev --key 0xADMINKEY \
 *        --remove qb_147c24c5_my-view
 *
 *   node examples/manage-views.mjs --worker https://…workers.dev --watchlist
 *
 * The key is only ever used locally to sign; it is never sent.
 */

import { privateKeyToAccount } from 'viem/accounts';

function parseArgs(argv) {
  const out = { sources: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--worker') out.worker = next();
    else if (arg === '--key') out.key = next();
    else if (arg === '--name') out.name = next();
    else if (arg === '--source') out.sources.push(next());
    else if (arg === '--remove') out.remove = next();
    else if (arg === '--hosted-mcp') out.hostedMcp = true;
    else if (arg === '--watchlist') out.watchlist = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

/** "0xOWNER:namespace" → { owner, namespace }. */
function parseSource(raw) {
  const [owner, ...rest] = raw.split(':');
  const namespace = rest.join(':');
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner || '') || !namespace) {
    throw new Error(`--source must be 0xOWNER:NAMESPACE, got "${raw}"`);
  }
  return { owner, namespace };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/**
 * The handshake. The first 401 carrying a challenge is the expected path, not a
 * failure — anything else on the first call is a real error worth surfacing as-is.
 */
async function signedPost(worker, path, account, payload) {
  const url = `${worker.replace(/\/$/, '')}${path}`;

  const first = await postJson(url, { address: account.address, ...payload });
  const challenge = first.json.challenge;
  if (!challenge) return first;

  const signature = await account.signMessage({ message: challenge });
  return postJson(url, { address: account.address, message: challenge, signature, ...payload });
}

function report(action, { status, json }) {
  console.log(`\n${action} → HTTP ${status}`);
  console.log(JSON.stringify(json, null, 2));

  if (status === 402) console.log('\n✘ That wallet has no active subscription. Subscribe at fangorn.network.');
  else if (status === 403) console.log('\n✘ Refused: either not a registered publisher, or not an admin wallet for this route.');
  else if (status === 401) console.log('\n✘ The signature did not verify. Wrong key for that address?');
  else if (status === 429) console.log('\n✘ Per-wallet view cap reached (MAX_VIEWS_PER_WALLET).');
  process.exitCode = status < 300 ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.worker) throw new Error('--worker <url> is required');
  const worker = args.worker.replace(/\/$/, '');

  // Read-only, so no key and no signature needed.
  if (args.watchlist) {
    const res = await fetch(`${worker}/watchlist`);
    console.log(`GET /watchlist → HTTP ${res.status}`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  if (!args.key) throw new Error('--key 0x… is required (used locally to sign; never sent)');
  const account = privateKeyToAccount(args.key.startsWith('0x') ? args.key : `0x${args.key}`);
  console.log(`worker : ${worker}`);
  console.log(`address: ${account.address}`);

  if (args.remove) {
    report(`POST /admin/remove ${args.remove}`,
      await signedPost(worker, '/admin/remove', account, { id: args.remove }));
    return;
  }

  if (!args.name) throw new Error('--name <view-name> is required');
  if (!args.sources.length) throw new Error('at least one --source 0xOWNER:NAMESPACE is required');
  const sources = args.sources.map(parseSource);

  console.log(`view   : ${args.name}`);
  console.log(`sources: ${sources.map((s) => `${s.owner}:${s.namespace}`).join(', ')}`);
  if (args.hostedMcp) console.log('hosted : yes (Cloud Run MCP requested)');

  report('POST /views', await signedPost(worker, '/views', account, {
    name: args.name,
    sources,
    hostedMcp: Boolean(args.hostedMcp),
  }));
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
});
