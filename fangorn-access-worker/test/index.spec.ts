import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encodePacked, keccak256, toBytes } from "viem";
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

// Deletion is what lets a publisher stop paying for something they took down —
// without it, sond3r's relay has to charge for every byte ever uploaded, because
// nothing it can do actually frees an R2 object.
describe("delete", () => {
	const del = (token?: string, id: string = RID) =>
		SELF.fetch(`https://w/upload/${id}`, {
			method: "DELETE",
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});

	it("removes the ciphertext and its sealed DEK together", async () => {
		await upload("ciphertext", "token-a");
		expect(await env.BUCKET.get(RID)).not.toBeNull();
		expect(await env.BUCKET.get(`${RID}.dek`)).not.toBeNull();

		expect((await del("token-a")).status).toBe(200);
		expect(await env.BUCKET.get(RID)).toBeNull();
		// A DEK left behind would go on releasing a key for bytes that are gone.
		expect(await env.BUCKET.get(`${RID}.dek`)).toBeNull();
	});

	it("refuses an unauthenticated delete", async () => {
		await upload("ciphertext", "token-a");
		expect((await del()).status).toBe(401);
		expect(await env.BUCKET.get(RID)).not.toBeNull();
	});

	it("refuses a stranger who learned the URL", async () => {
		await upload("ciphertext", "token-a");
		expect((await del("token-b")).status).toBe(401);
		expect(await env.BUCKET.get(RID)).not.toBeNull();
	});

	// The same guard that keeps /ct/ off the private key keeps DELETE off it.
	it("cannot delete the worker's own secret or the token record", async () => {
		await upload("ciphertext", "token-a");
		expect((await del("token-a", ".worker-x25519-secret")).status).toBe(400);
		expect((await del("token-a", ".upload-token")).status).toBe(400);
		expect(await env.BUCKET.get(".upload-token")).not.toBeNull();
	});

	it("is idempotent, so a retry after a half-finished delete is safe", async () => {
		await upload("ciphertext", "token-a");
		expect((await del("token-a")).status).toBe(200);
		expect((await del("token-a")).status).toBe(200);
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

// ------------------------------------------------------------
// The /access gate — the only thing standing between a stranger and every DEK
// in the bucket. The registry is mocked at the JSON-RPC layer so each rule can
// be exercised on its own.
//
// A request that PASSES the gate falls through to "sealed DEK not found" (404),
// because these fixtures never upload one. That 404 is the success signal: it
// can only be reached after verify() returned ok.
// ------------------------------------------------------------
describe("/access gate", () => {
	const BUYER = privateKeyToAccount(`0x${"33".repeat(32)}`);
	const OWNER = `0x${"44".repeat(40 / 2)}` as const;

	const selector = (sig: string) => keccak256(toBytes(sig)).slice(0, 10);
	const SEL = {
		isSettled: selector("isSettled(address,bytes32)"),
		getPrice: selector("getPrice(bytes32)"),
		getOwner: selector("getOwner(bytes32)"),
		isDisabled: selector("isDisabled(bytes32)"),
	};
	const word = (v: string | bigint | boolean) =>
		typeof v === "string"
			? v.replace(/^0x/, "").padStart(64, "0")
			: BigInt(v).toString(16).padStart(64, "0");

	// The worker and this test share one isolate, so the viem client's outbound
	// calls go through the same global fetch — stubbing it IS the RPC mock. The
	// pool version here exports no fetchMock, and a whole undici MockAgent would
	// be a lot of machinery for "answer four eth_calls".
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	/** Stub the registry: every eth_call is answered from `state`. */
	function mockRegistry(state: { owner?: string; price?: bigint; disabled?: boolean; settled?: boolean }) {
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!url.includes("arbitrum")) return realFetch(input as RequestInfo, init);

			const rpc = JSON.parse(String(init?.body));
			const data: string = rpc.params?.[0]?.data ?? "";
			const answer = data.startsWith(SEL.getOwner)
				? word(state.owner ?? `0x${"00".repeat(20)}`)
				: data.startsWith(SEL.getPrice)
					? word(state.price ?? 0n)
					: data.startsWith(SEL.isDisabled)
						? word(state.disabled ?? false)
						: data.startsWith(SEL.isSettled)
							? word(state.settled ?? false)
							: word(0n);

			return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: `0x${answer}` }), {
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
	}

	const access = async (resourceId: string = RID) => {
		const nullifier = `0x${"07".repeat(32)}` as const;
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = await BUYER.signMessage({
			message: {
				raw: keccak256(
					encodePacked(["uint256", "bytes32", "uint64"], [BigInt(nullifier), resourceId as `0x${string}`, BigInt(timestamp)]),
				),
			},
		});
		const res = await SELF.fetch("https://w/access", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ nullifier, resourceId, timestamp, signature }),
		});
		return { status: res.status, reason: (await res.json<{ reason?: string; error?: string }>()).error };
	};

	// The registry keeps `isSettled` true after a takedown on purpose — the
	// payment happened. So a disabled resource is refused here or nowhere, and
	// refusing only unsettled callers would be refusing nobody who matters.
	it("refuses a disabled resource even to a buyer who settled", async () => {
		mockRegistry({ owner: OWNER, price: 1000n, disabled: true, settled: true });
		expect(await access()).toMatchObject({ status: 403, reason: "resource disabled" });
	});

	// An unregistered resource reads back price 0. Treating that as "free" would
	// hand out the DEK for any object the registry has never heard of.
	it("refuses a resource the registry does not know", async () => {
		mockRegistry({ price: 0n });
		expect(await access()).toMatchObject({ status: 403, reason: "unknown resource" });
	});

	it("refuses a priced resource the caller has not settled", async () => {
		mockRegistry({ owner: OWNER, price: 1000n, settled: false });
		expect(await access()).toMatchObject({ status: 403, reason: "not settled" });
	});

	it("passes a priced resource the caller has settled", async () => {
		mockRegistry({ owner: OWNER, price: 1000n, settled: true });
		expect((await access()).status).toBe(404); // past the gate; no DEK uploaded
	});

	it("passes a free resource to any valid signer", async () => {
		mockRegistry({ owner: OWNER, price: 0n });
		expect((await access()).status).toBe(404);
	});

	it("refuses a stale timestamp before it ever asks the chain", async () => {
		// Any RPC call in this test would throw rather than answer — which is the
		// assertion: the cheap checks run before the worker talks to a chain.
		globalThis.fetch = (() => {
			throw new Error("the gate must not reach the chain for a stale request");
		}) as unknown as typeof fetch;
		const res = await SELF.fetch("https://w/access", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				nullifier: "0x01",
				resourceId: RID,
				timestamp: Math.floor(Date.now() / 1000) - 3600,
				signature: `0x${"00".repeat(65)}`,
			}),
		});
		expect(res.status).toBe(403);
	});
});
