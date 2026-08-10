import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

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

describe("/claim", () => {
	it("claims without uploading, and is idempotent", async () => {
		const claim = (token: string) =>
			SELF.fetch("https://w/claim", { method: "POST", headers: { Authorization: `Bearer ${token}` } });

		expect((await claim("token-a")).status).toBe(200);
		expect((await claim("token-a")).status).toBe(200);
		expect((await claim("token-b")).status).toBe(401);

		// The claim really gated uploads, not just itself.
		expect((await upload("theirs", "token-b")).status).toBe(401);
		expect((await upload("mine", "token-a")).status).toBe(201);
	});
});
