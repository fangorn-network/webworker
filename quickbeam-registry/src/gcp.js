/**
 * Cloud Run provisioning for hosted MCP servers.
 *
 * When a requester ticks "host an MCP for me", we run one Cloud Run service per view:
 * the same quickbeam image, `mcp --cdn-url <that view's filtered catalog>`. That is a
 * good fit for Cloud Run and a bad one for the watcher — an MCP is stateless, holds no
 * connections, needs no disk, and scales to zero, so an idle user's MCP costs nothing.
 *
 * No SDK: a service-account JWT signed with WebCrypto, exchanged for an access token,
 * then plain REST. The token is cached in KV because minting one costs a round trip
 * and a signature.
 */

const TOKEN_KEY = 'gcp:token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** True when enough is configured to provision anything. */
export function gcpConfigured(env) {
  return Boolean(env.GCP_PROJECT && env.GCP_REGION && env.GCP_SA_EMAIL && env.GCP_SA_KEY
    && env.QUICKBEAM_IMAGE);
}

/**
 * Cloud Run service name for a view. Service names are lowercase alphanumerics and
 * hyphens only — a view id like `qb_147c24c5_music` has underscores, so they become
 * hyphens. The same transform names the view's DNS label, so the two always agree.
 */
export function serviceName(viewId) {
  return viewId.replace(/_/g, '-').toLowerCase().slice(0, 49).replace(/-+$/, '');
}

/* ─────────────────────────────── auth ───────────────────────────────────── */

function b64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PEM (PKCS#8) → ArrayBuffer, for crypto.subtle.importKey. */
function pemToArrayBuffer(pem) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function mintToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(new TextEncoder().encode(JSON.stringify({
    iss: env.GCP_SA_EMAIL,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })));
  const signingInput = `${header}.${claims}`;

  // The key arrives with literal "\n" when it is pasted from a JSON key file.
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(String(env.GCP_SA_KEY).replace(/\\n/g, '\n')),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(signingInput));

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`GCP token HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!body.access_token) throw new Error('GCP token response had no access_token');
  return body;
}

async function accessToken(env) {
  const cached = env.REGISTRY_KV ? await env.REGISTRY_KV.get(TOKEN_KEY) : null;
  if (cached) return cached;
  const { access_token, expires_in } = await mintToken(env);
  if (env.REGISTRY_KV) {
    // Expire early so a token is never used in its last minutes.
    await env.REGISTRY_KV.put(TOKEN_KEY, access_token,
      { expirationTtl: Math.max(60, Number(expires_in || 3600) - 300) });
  }
  return access_token;
}

async function runApi(env, path, init = {}) {
  const token = await accessToken(env);
  const base = `https://run.googleapis.com/v2/projects/${env.GCP_PROJECT}/locations/${env.GCP_REGION}`;
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

/* ───────────────────────────── services ─────────────────────────────────── */

/**
 * Create the view's MCP service. Idempotent from the caller's side: an ALREADY_EXISTS
 * is reported as success, because the desired state is "a service exists for this
 * view", not "this call created it".
 */
export async function createMcpService(env, { viewId, cdnUrl }) {
  const name = serviceName(viewId);
  const service = {
    labels: { 'managed-by': 'quickbeam-registry', 'qb-view': name },
    template: {
      // Scale to zero: an idle user's MCP costs nothing. maxInstanceCount caps a
      // runaway agent rather than the bill from normal use.
      scaling: { minInstanceCount: 0, maxInstanceCount: 2 },
      containers: [{
        image: env.QUICKBEAM_IMAGE,
        args: ['mcp', `--cdn-url=${cdnUrl}`, '--transport=http', '--host=0.0.0.0', '--port=8080'],
        ports: [{ containerPort: 8080 }],
        // It embeds queries locally with fastembed, so the ONNX model is resident.
        resources: { limits: { cpu: '1', memory: '2Gi' } },
      }],
    },
  };

  const created = await runApi(env, `/services?serviceId=${name}`, {
    method: 'POST',
    body: JSON.stringify(service),
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(`Cloud Run create failed (${created.status}): ${JSON.stringify(created.body)}`);
  }

  // Agents call it directly, so it has to be publicly invokable.
  const iam = await runApi(env, `/services/${name}:setIamPolicy`, {
    method: 'POST',
    body: JSON.stringify({
      policy: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] },
    }),
  });
  if (!iam.ok) {
    throw new Error(`Cloud Run setIamPolicy failed (${iam.status}): ${JSON.stringify(iam.body)}`);
  }
  return { name, status: 'provisioning' };
}

/** The service's public URL once Cloud Run has one, else null. */
export async function getMcpService(env, viewId) {
  const name = serviceName(viewId);
  const res = await runApi(env, `/services/${name}`);
  if (res.status === 404) return { name, status: 'absent', url: null };
  if (!res.ok) throw new Error(`Cloud Run get failed (${res.status})`);
  const url = res.body.uri || null;
  return { name, status: url ? 'ready' : 'provisioning', url };
}

/** Delete the service. A 404 is success — the desired state is "gone". */
export async function deleteMcpService(env, viewId) {
  const name = serviceName(viewId);
  const res = await runApi(env, `/services/${name}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Cloud Run delete failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { name, status: 'deleted' };
}
