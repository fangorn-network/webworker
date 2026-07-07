/**
 * Simulated caller for onchain-gate's address-ownership check.
 *
 * Demonstrates the full ownership handshake against a running worker:
 *
 *   1. POST { address }                          → 401 + a `challenge` to sign
 *   2. sign the challenge with the address's key (EIP-191 personal_sign, via viem)
 *   3. POST { address, message, signature }      → ownership accepted; the worker
 *      then evaluates the on-chain condition and (if met) returns an upload URL.
 *
 * Usage:
 *   node examples/simulated-caller.mjs [workerUrl]
 *
 * Env:
 *   WORKER_URL    Worker base URL (default http://localhost:8787).
 *   PRIVATE_KEY   0x-prefixed 32-byte secp256k1 key. Omit to use the demo key
 *                 below — NEVER use that key for anything real.
 */

import { privateKeyToAccount } from 'viem/accounts';

// A throwaway demo key. Deterministic so the example is reproducible.
// DO NOT fund this address or reuse this key anywhere real.
const DEMO_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const WORKER_URL = process.argv[2] || process.env.WORKER_URL || 'http://localhost:8787';

async function postJson(body) {
  const res = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  let privHex = process.env.PRIVATE_KEY || DEMO_PRIVATE_KEY;
  if (!privHex.startsWith('0x')) privHex = '0x' + privHex;
  const account = privateKeyToAccount(privHex); // throws on a malformed key
  const address = account.address;

  console.log(`Worker : ${WORKER_URL}`);
  console.log(`Address: ${address}`);
  if (!process.env.PRIVATE_KEY) console.log('(using the built-in demo key — set PRIVATE_KEY to override)');

  // 1) Ask the worker for a challenge (no signature yet → 401).
  console.log('\n[1] Requesting challenge (unsigned)…');
  const first = await postJson({ address });
  console.log(`    → HTTP ${first.status}`);
  const challenge = first.json.challenge;
  if (first.status !== 401 || !challenge) {
    throw new Error(`Expected 401 + challenge, got HTTP ${first.status}: ${JSON.stringify(first.json)}`);
  }
  console.log('    Challenge to sign:\n' + challenge.split('\n').map((l) => '      ' + l).join('\n'));

  // 2) Sign it with the address's key (viem applies the EIP-191 prefix).
  console.log('\n[2] Signing challenge…');
  const signature = await account.signMessage({ message: challenge });
  console.log(`    signature: ${signature}`);

  // 3) Resend with the proof.
  console.log('\n[3] Resending with { address, message, signature }…');
  const second = await postJson({ address, message: challenge, signature });
  console.log(`    → HTTP ${second.status}`);
  console.log('    ' + JSON.stringify(second.json, null, 2).split('\n').join('\n    '));

  console.log('\nResult:');
  if (second.status === 200) {
    console.log('  ✔ Ownership proven AND on-chain condition met — got an upload URL.');
  } else if (second.status === 403) {
    console.log('  ✔ Ownership proven (signature accepted). ✘ On-chain condition not met for this address.');
  } else if (second.status === 401) {
    console.log('  ✘ Ownership check rejected the signature. See the error above.');
  } else {
    console.log(`  ? Unexpected HTTP ${second.status}.`);
  }
}

main().catch((err) => {
  console.error('\nError:', err.message);
  console.error(`\nIs the worker running? Start it with:  cd onchain-gate && npm run dev`);
  process.exit(1);
});
