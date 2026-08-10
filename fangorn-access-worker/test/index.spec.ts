import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

// The worker is a key-release oracle over a bucket it also owns. These cover the
// three things that make a PUBLISHER-OWNED deployment safe to hand someone who
// has never heard of R2: it mints its own identity, it does not serve that
// identity back out, and it will not let a stranger overwrite their ciphertext.

const RID = `0x${"ab".repeat(32)}` as const;
const HEX64 = /^0x[0-9a-f]{64}$/;

const upload = (body: string, token?: string, id: string = RID) =>
	SELF.fetch(`https://w/upload/${id}`, {
		method: "POST",
		headers: {
			"X-Sealed-Dek": `0x${"11".repeat(76)}`,
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body,
	});

// Each test starts on a fresh, unclaimed bucket — the state a publisher's worker
// is in the moment the Deploy to Cloudflare button finishes.
beforeEach(async () => {
	const { objects } = await env.BUCKET.list();
	await Promise.all(objects.map((o) => env.BUCKET.delete(o.key)));
});

describe("worker identity", () => {
	it("mints an X25519 key on first use and keeps it", async () => {
		const first = await (await SELF.fetch("https://w/pubkey")).json<{ pubkey: string }>();
		expect(first.pubkey).toMatch(HEX64);

		// Stability is the whole property: a second mint would strand every DEK
		// already sealed to the first key.
		const second = await (await SELF.fetch("https://w/pubkey")).json<{ pubkey: string }>();
		expect(second.pubkey).toBe(first.pubkey);
	});

	it("does not serve its own secret through the ungated /ct route", async () => {
		await SELF.fetch("https://w/pubkey"); // force the mint
		expect(await env.BUCKET.get(".worker-x25519-secret")).not.toBeNull();

		// /ct/ is deliberately unauthenticated — it serves ciphertext. Without the
		// bytes32 key guard this request would hand out the private key that opens
		// every DEK in the bucket.
		const res = await SELF.fetch("https://w/ct/.worker-x25519-secret");
		expect(res.status).toBe(404);
	});
});

describe("upload gate", () => {
	it("refuses an unauthenticated upload", async () => {
		expect((await upload("ciphertext")).status).toBe(401);
	});

	it("claims an unclaimed bucket to the first token, then rejects others", async () => {
		expect((await upload("mine", "token-a")).status).toBe(201);
		// Same token again: still the owner.
		expect((await upload("mine too", "token-a")).status).toBe(201);
		// A stranger who learned the URL cannot overwrite the publisher's bytes.
		expect((await upload("theirs", "token-b")).status).toBe(401);
	});

	it("stores only the token's hash, never the token", async () => {
		await upload("mine", "token-a");
		expect(await (await env.BUCKET.get(".upload-token"))!.text()).not.toContain("token-a");
	});

	it("rejects a key that is not a bytes32", async () => {
		expect((await upload("x", "token-a", ".upload-token")).status).toBe(400);
	});
});

// The publisher's wallet is the authority over the bucket — see handleClaim.
const PUBLISHER = privateKeyToAccount(`0x${"11".repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${"22".repeat(32)}`);

const digestOf = async (token: string) =>
	`0x${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))]
		.map((b) => b.toString(16).padStart(2, "0")).join("")}`;

// Duplicated from the worker on purpose: if src/ changes this string, this test
// should fail rather than follow along — sond3r's relay builds it independently
// (server/index.js, `claimMessage`) and both sides must keep producing the same
// bytes. CLAIM_VECTOR below pins the format for the relay's own self-check.
const claimMessage = async (token: string, timestamp: number) =>
	`sond3r storage claim\ntoken: ${await digestOf(token)}\ntime: ${timestamp}`;

const claim = async (token: string, signer?: typeof PUBLISHER, timestamp = Math.floor(Date.now() / 1000)) =>
	SELF.fetch("https://w/claim", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			timestamp,
			signature: signer ? await signer.signMessage({ message: await claimMessage(token, timestamp) }) : undefined,
		}),
	});

describe("/claim", () => {
	it("pins the message format the relay signs against", async () => {
		// sond3r/server/upload-token.js asserts the same literal. Two repos, one
		// string: change it in one place only and the pair of tests catches it.
		expect(await claimMessage("token-a", 1700000000)).toBe(
			"sond3r storage claim\ntoken: 0xa70bf50e531ce1a817561f2f5d5b6645d4e806becf58ccc5e8cf6b8045a090a8\ntime: 1700000000"
		);
	});

	it("claims without uploading, and is idempotent", async () => {
		expect((await claim("token-a", PUBLISHER)).status).toBe(200);
		// Re-presenting the winning token is idempotent and needs no signature.
		expect((await claim("token-a")).status).toBe(200);
		expect((await claim("token-b")).status).toBe(401);

		// The claim really gated uploads, not just itself.
		expect((await upload("theirs", "token-b")).status).toBe(401);
		expect((await upload("mine", "token-a")).status).toBe(201);
	});

	it("refuses an unsigned claim on a bucket held by another token", async () => {
		await claim("token-a", PUBLISHER);
		const res = await claim("token-b");
		expect(res.status).toBe(401);
		expect((await res.json<{ reason: string }>()).reason).toBe("needs-signature");
	});

	// The bug this whole path exists for: rotating ETH_PRIVATE_KEY changes the
	// relay's derived token, and used to strand the publisher's own bucket behind
	// a wrangler command.
	it("lets the owning wallet rotate to a new token", async () => {
		await claim("old-token", PUBLISHER);
		expect((await claim("new-token", PUBLISHER)).status).toBe(200);

		expect((await upload("mine", "new-token")).status).toBe(201);
		expect((await upload("stale", "old-token")).status).toBe(401);
	});

	it("refuses a takeover signed by a different wallet", async () => {
		await claim("token-a", PUBLISHER);
		const res = await claim("token-b", STRANGER);
		expect(res.status).toBe(401);
		expect((await res.json<{ reason: string }>()).reason).toBe("not-owner");
	});

	it("says so when the worker pins a token, which no signature can override", async () => {
		(env as { UPLOAD_TOKEN?: string }).UPLOAD_TOKEN = "pinned-secret";
		try {
			const res = await claim("token-a", PUBLISHER);
			expect(res.status).toBe(401);
			expect((await res.json<{ reason: string }>()).reason).toBe("pinned");
			expect((await claim("pinned-secret")).status).toBe(200);
		} finally {
			delete (env as { UPLOAD_TOKEN?: string }).UPLOAD_TOKEN;
		}
	});
});
