/**
 * onchain-gate — a self-contained Cloudflare Worker.
 *
 * Flow:
 *   1. Caller hits the worker with ?address=0x...
 *   2. The worker makes a read-only `eth_call` to a configured contract view
 *      function on a configured EVM chain.
 *   3. It compares the returned value against a configured condition. (This step
 *      can be stubbed with STUB_CONTRACT_CALL="true" so ownership alone gates.)
 *   4. If the condition passes, it mints a short-lived Pinata *presigned upload
 *      URL* and returns it, so the caller can pin one file to IPFS without ever
 *      seeing your Pinata JWT.
 *
 * The only dependency is `viem` (used for signature recovery). All behaviour is
 * driven by environment variables (see wrangler.toml / README).
 *
 * ── Ownership gating ─────────────────────────────────────────────────────────
 * On its own, the on-chain check only proves that *an address* satisfies the
 * condition — not that the caller controls it. So every request must carry a
 * short challenge message signed by that address (EIP-191 `personal_sign`); the
 * worker recovers the signer with viem and requires it to equal the requested
 * address — see `verifyCallerOwnsAddress()`. This is always enforced. A runnable
 * caller lives in `examples/`.
 */

import { recoverMessageAddress } from 'viem';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'Method not allowed. Use GET or POST.' }, cors);
    }

    // Read the request once (the POST body can only be consumed a single time):
    // address plus the optional ownership proof (message + signature).
    const input = await readInput(request);
    const address = (input.address || '').toLowerCase();
    if (!isAddress(address)) {
      return json(400, { error: 'Provide a valid EVM address via ?address=0x… or JSON body { "address": "0x…" }.' }, cors);
    }

    // Prove the caller controls `address` via a signed challenge (always required).
    const ownership = await verifyCallerOwnsAddress(input, address, env);
    if (!ownership.ok) {
      return json(401, {
        ok: false,
        address,
        error: ownership.error,
        // Echo the exact message the caller must sign, so they can retry.
        challenge: ownership.challenge,
      }, cors);
    }

    // 1) Evaluate the on-chain condition — unless STUB_CONTRACT_CALL is set, in
    // which case a valid signature alone is enough (useful for local dev/testing
    // without an RPC endpoint).
    const stubbed = (env.STUB_CONTRACT_CALL ?? 'false') === 'true';
    if (!stubbed) {
      let passed;
      try {
        passed = await checkCondition(env, address);
      } catch (err) {
        return json(502, { error: 'On-chain check failed.', detail: String(err?.message || err) }, cors);
      }
      if (!passed) {
        return json(403, { ok: false, address, error: 'On-chain condition not met.' }, cors);
      }
    }

    // 2) Condition met (or stubbed) — issue a Pinata presigned upload URL.
    try {
      const uploadUrl = await createPinataUploadUrl(env);
      return json(200, {
        ok: true,
        address,
        uploadUrl,
        network: env.PINATA_NETWORK || 'public',
        expiresIn: Number(env.PINATA_URL_EXPIRES || 300),
        ...(stubbed ? { stubbed: true } : {}),
      }, cors);
    } catch (err) {
      return json(502, { error: 'Failed to create Pinata upload URL.', detail: String(err?.message || err) }, cors);
    }
  },
};

/* ───────────────────────────── on-chain check ──────────────────────────── */

/**
 * Calls a single view function and compares its first returned 32-byte word
 * (interpreted as a uint256 / bool) against the configured condition.
 *
 * Env:
 *   RPC_URL           EVM JSON-RPC endpoint (secret).
 *   CONTRACT_ADDRESS  Contract to call.
 *   VIEW_SELECTOR     4-byte function selector, e.g. 0x70a08231 (balanceOf).
 *   PASS_ADDRESS_ARG  "true" to append the requestor address as the sole arg.
 *   COMPARE_OP        gte | gt | lte | lt | eq | nonzero | zero | bool.
 *   COMPARE_VALUE     Decimal string compared as a bigint (for the numeric ops).
 */
async function checkCondition(env, address) {
  if (!env.RPC_URL) throw new Error('RPC_URL is not set.');
  if (!isAddress(env.CONTRACT_ADDRESS || '')) throw new Error('CONTRACT_ADDRESS is missing or invalid.');
  if (!/^0x[0-9a-fA-F]{8}$/.test(env.VIEW_SELECTOR || '')) {
    throw new Error('VIEW_SELECTOR must be a 4-byte selector like 0x70a08231.');
  }

  const passArg = (env.PASS_ADDRESS_ARG ?? 'true') !== 'false';
  const data = env.VIEW_SELECTOR + (passArg ? encodeAddress(address) : '');

  const res = await fetch(env.RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: env.CONTRACT_ADDRESS, data }, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${body.error.message || JSON.stringify(body.error)}`);

  const word = firstWord(body.result);
  return compare(word, env);
}

function compare(word, env) {
  const op = (env.COMPARE_OP || 'nonzero').toLowerCase();
  const value = env.COMPARE_VALUE != null && env.COMPARE_VALUE !== '' ? BigInt(env.COMPARE_VALUE) : 0n;
  switch (op) {
    case 'nonzero': return word !== 0n;
    case 'zero': return word === 0n;
    case 'bool': return word === 1n;
    case 'gte': return word >= value;
    case 'gt': return word > value;
    case 'lte': return word <= value;
    case 'lt': return word < value;
    case 'eq': return word === value;
    default: throw new Error(`Unknown COMPARE_OP: ${op}`);
  }
}

/* ───────────────────────────── pinata ──────────────────────────────────── */

/**
 * Mints a Pinata presigned upload URL. The caller can then upload one file with:
 *   const fd = new FormData();
 *   fd.append('file', file);
 *   fd.append('network', '<network>');
 *   await fetch(uploadUrl, { method: 'POST', body: fd });
 *
 * Docs: https://docs.pinata.cloud/files/presigned-urls
 */
async function createPinataUploadUrl(env) {
  if (!env.PINATA_JWT) throw new Error('PINATA_JWT is not set.');

  const payload = {
    network: env.PINATA_NETWORK || 'public',
    expires: Number(env.PINATA_URL_EXPIRES || 300),
    date: Math.floor(Date.now() / 1000),
  };
  if (env.PINATA_MAX_FILE_SIZE) payload.max_file_size = Number(env.PINATA_MAX_FILE_SIZE);
  if (env.PINATA_ALLOW_MIME_TYPES) {
    payload.allow_mime_types = env.PINATA_ALLOW_MIME_TYPES.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const res = await fetch('https://uploads.pinata.cloud/v3/files/sign', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.PINATA_JWT}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Pinata HTTP ${res.status}: ${data ? JSON.stringify(data) : '(no body)'}`);

  const url = data?.data || data?.url;
  if (!url) throw new Error(`Pinata returned no signed URL: ${JSON.stringify(data)}`);
  return url;
}

/* ───────────────────────────── helpers ─────────────────────────────────── */

/**
 * Prove the caller controls `address` by verifying a signed challenge.
 *
 * The caller signs the exact message from `buildChallengeMessage(address, now)`
 * with the private key behind `address` (EIP-191 `personal_sign`) and sends the
 * `message` + `signature` alongside it. We:
 *   1. parse the address + Issued-At back out of the message,
 *   2. require the message to be the canonical template verbatim (no tampering),
 *   3. require Issued-At to be fresh (within SIGNATURE_MAX_AGE) to bound replay,
 *   4. recover the signer from the signature and require it to equal `address`.
 *
 * Returns { ok: true } or { ok: false, error, challenge } — `challenge` is a
 * freshly-minted message the caller can sign and retry with.
 *
 * This is always enforced: the whole point is to bind the on-chain check to a
 * caller who provably controls the address, so there is no unauthenticated mode.
 *
 * Env:
 *   SIGNATURE_MAX_AGE   How many seconds old an Issued-At may be (default 300).
 */
async function verifyCallerOwnsAddress(input, address, env) {
  const now = Math.floor(Date.now() / 1000);
  const challenge = buildChallengeMessage(address, now);
  const fail = (error) => ({ ok: false, error, challenge });

  const { message, signature } = input;
  if (!message || !signature) {
    return fail('Signature required. Sign the `challenge` message with the address\'s key and resend it as { message, signature }.');
  }

  const parsed = parseChallengeMessage(message);
  if (!parsed) return fail('Malformed challenge message.');
  if (parsed.address.toLowerCase() !== address) {
    return fail('The signed message is for a different address.');
  }

  // Reject anything that is not the canonical template verbatim.
  if (message !== buildChallengeMessage(parsed.address, parsed.issuedAt)) {
    return fail('Challenge message does not match the expected format.');
  }

  // Freshness: bound replay without server-side state. Allow small clock skew.
  const maxAge = Number(env.SIGNATURE_MAX_AGE || 300);
  const skew = 60;
  if (!(parsed.issuedAt <= now + skew && parsed.issuedAt >= now - maxAge)) {
    return fail('Challenge expired or not yet valid. Sign the fresh `challenge`.');
  }

  // Recover the signer (EIP-191 personal_sign) and require it to equal `address`.
  let recovered;
  try {
    recovered = await recoverMessageAddress({ message, signature });
  } catch {
    return fail('Malformed signature.');
  }
  if (recovered.toLowerCase() !== address) {
    return fail('Signature does not match the address.');
  }
  return { ok: true };
}

/**
 * The exact human-readable message a caller must sign to prove address control.
 * `issuedAt` is unix seconds; freshness is enforced against it above.
 */
function buildChallengeMessage(address, issuedAt) {
  return [
    'Fangorn onchain-gate access request',
    '',
    'I am proving that I control the wallet address below so the gate can issue',
    'me a one-time upload URL. This signature authorizes nothing else.',
    '',
    `Address: ${address}`,
    `Issued-At: ${issuedAt}`,
  ].join('\n');
}

/** Parse a challenge message back into { address, issuedAt }, or null. */
function parseChallengeMessage(message) {
  if (typeof message !== 'string') return null;
  const addr = message.match(/^Address: (0x[0-9a-fA-F]{40})$/m);
  const issued = message.match(/^Issued-At: (\d{1,20})$/m);
  if (!addr || !issued) return null;
  return { address: addr[1], issuedAt: Number(issued[1]) };
}

/** Collect { address, message, signature } from the query and/or a JSON body. */
async function readInput(request) {
  const q = new URL(request.url).searchParams;
  const out = {
    address: q.get('address')?.trim() || '',
    message: q.get('message') ?? undefined,          // signed verbatim — never trim
    signature: q.get('signature')?.trim() || undefined,
  };
  if (request.method === 'POST') {
    const body = await request.json().catch(() => null);
    if (body && typeof body === 'object') {
      if (!out.address && typeof body.address === 'string') out.address = body.address.trim();
      if (out.message == null && typeof body.message === 'string') out.message = body.message;
      if (!out.signature && typeof body.signature === 'string') out.signature = body.signature.trim();
    }
  }
  return out;
}

function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Left-pads a 20-byte address to a 32-byte ABI word (hex, no 0x prefix). */
function encodeAddress(address) {
  return address.replace(/^0x/, '').toLowerCase().padStart(64, '0');
}

/** Reads the first 32-byte word of an eth_call result as a bigint. */
function firstWord(result) {
  if (!result || result === '0x') return 0n;
  const hex = result.slice(2, 66).padStart(64, '0');
  return BigInt('0x' + hex);
}

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
  };
}

function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(extraHeaders || {}) },
  });
}
