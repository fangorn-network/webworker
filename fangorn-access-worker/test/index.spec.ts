import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encodePacked, keccak256, toBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// The worker is a key-release oracle over a bucket it shares between EVERY
// publisher on the relay. These cover what makes that safe: it mints its own
// identity, it does not serve that identity back out, only a relay-minted token
// can write at all, and one publisher cannot touch another's objects.

const RID = `0x${"ab".repeat(32)}` as const;
const HEX64 = /^0x[0-9a-f]{64}$/;

// The secret the relay and the worker share. Installed on `env` here because
// wrangler.toml deliberately does not carry it — it is a `wrangler secret`.
const SECRET = `0x${"5e".repeat(32)}` as Hex;

const ALICE = "0x1111111111111111111111111111111111111111" as Address;
const BOB = "0x2222222222222222222222222222222222222222" as Address;

/** What sond3r's `uploadTokenFor` hands a publisher's browser. */
const tokenFor = (owner: Address, secret: Hex = SECRET) =>
	`${owner}.${keccak256(encodePacked(["bytes32", "address"], [secret, owner]))}`;

const upload = (body: string, token?: string, id: string = RID) =>
	SELF.fetch(`https://w/upload/${id}`, {
		method: "POST",
		headers: {
			"X-Sealed-Dek": `0x${"11".repeat(76)}`,
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body,
	});

// Each test starts on an empty bucket with the shared secret configured.
beforeEach(async () => {
	(env as { UPLOAD_HMAC_SECRET?: string }).UPLOAD_HMAC_SECRET = SECRET;
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
	// A cross-repo contract, and the quietest one to get wrong: sond3r's relay
	// mints this token independently (server/index.js, `uploadTokenWith`) and its
	// --selfcheck asserts the identical literal. If either side drifts, one of the
	// two suites goes red instead of every upload silently 401ing.
	it("agrees with the relay on the token format", () => {
		expect(tokenFor("0x1111111111111111111111111111111111111111", `0x${"5e".repeat(32)}`)).toBe(
			"0x1111111111111111111111111111111111111111.0x7908a77e560b9353c8bfc501f7654a7c3ba31939f0b83d123edac190f797c7fd",
		);
	});

	it("refuses an unauthenticated upload", async () => {
		expect((await upload("ciphertext")).status).toBe(401);
	});

	it("accepts a relay-minted token and refuses a forged one", async () => {
		expect((await upload("mine", tokenFor(ALICE))).status).toBe(201);
		// Same publisher again: overwriting your own object is an ordinary republish.
		expect((await upload("mine too", tokenFor(ALICE))).status).toBe(201);
		// Right shape, wrong secret — the whole point of the MAC.
		expect((await upload("theirs", tokenFor(ALICE, `0x${"99".repeat(32)}`))).status).toBe(401);
		// A bare address with no MAC authorizes nobody.
		expect((await upload("theirs", ALICE)).status).toBe(401);
	});

	// The bucket is shared, so this is THE isolation property: uids are public, so
	// Bob can compute Alice's resourceId — he just cannot write to it.
	it("refuses a publisher writing over another publisher's object", async () => {
		expect((await upload("alice", tokenFor(ALICE))).status).toBe(201);
		expect((await upload("bob", tokenFor(BOB))).status).toBe(403);
		expect(await (await env.BUCKET.get(RID))!.text()).toBe("alice");
	});

	it("stamps the owner on the ciphertext AND its sealed DEK", async () => {
		await upload("alice", tokenFor(ALICE));
		expect((await env.BUCKET.head(RID))!.customMetadata?.owner).toBe(ALICE);
		// Unstamped, the DEK would be writable by anyone — and swapping a DEK is how
		// you make a publisher's file decrypt to something else.
		expect((await env.BUCKET.head(`${RID}.dek`))!.customMetadata?.owner).toBe(ALICE);
	});

	// An object left by the pre-shared-bucket deployment has nobody to attribute
	// it to. Adopting it would hand it to whoever asked first.
	it("refuses an existing object with no owner recorded", async () => {
		await env.BUCKET.put(RID, "from the old deployment");
		expect((await upload("mine now", tokenFor(ALICE))).status).toBe(403);
	});

	// Uploads are refused outright rather than falling open — a misconfigured
	// worker would otherwise be an open write endpoint on a bucket we pay for.
	it("authorizes nobody when the shared secret is missing", async () => {
		delete (env as { UPLOAD_HMAC_SECRET?: string }).UPLOAD_HMAC_SECRET;
		expect((await upload("mine", tokenFor(ALICE))).status).toBe(401);
	});

	it("rejects a key that is not a bytes32", async () => {
		expect((await upload("x", tokenFor(ALICE), ".worker-x25519-secret")).status).toBe(400);
	});
});

// The mirror of upload, and the reason it is gated: a publisher's manifest is
// read back through here, and on a shared bucket that is somebody's library
// index, not ciphertext.
describe("read-back", () => {
	const fetchOwn = (token?: string, id: string = RID) =>
		SELF.fetch(`https://w/upload/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

	it("gives a publisher their own object back", async () => {
		await upload("alice", tokenFor(ALICE));
		expect(await (await fetchOwn(tokenFor(ALICE))).text()).toBe("alice");
	});

	it("refuses another publisher's object, and anyone with no token", async () => {
		await upload("alice", tokenFor(ALICE));
		expect((await fetchOwn(tokenFor(BOB))).status).toBe(403);
		expect((await fetchOwn()).status).toBe(401);
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
		await upload("ciphertext", tokenFor(ALICE));
		expect(await env.BUCKET.get(RID)).not.toBeNull();
		expect(await env.BUCKET.get(`${RID}.dek`)).not.toBeNull();

		expect((await del(tokenFor(ALICE))).status).toBe(200);
		expect(await env.BUCKET.get(RID)).toBeNull();
		// A DEK left behind would go on releasing a key for bytes that are gone.
		expect(await env.BUCKET.get(`${RID}.dek`)).toBeNull();
	});

	it("refuses an unauthenticated delete", async () => {
		await upload("ciphertext", tokenFor(ALICE));
		expect((await del()).status).toBe(401);
		expect(await env.BUCKET.get(RID)).not.toBeNull();
	});

	// A registered publisher is still a stranger to someone else's library. Without
	// this, any one of them could empty the shared bucket.
	it("refuses another publisher, token and all", async () => {
		await upload("ciphertext", tokenFor(ALICE));
		expect((await del(tokenFor(BOB))).status).toBe(403);
		expect(await env.BUCKET.get(RID)).not.toBeNull();
	});

	// The same guard that keeps /ct/ off the private key keeps DELETE off it.
	it("cannot delete the worker's own secret", async () => {
		await SELF.fetch("https://w/pubkey"); // force the mint
		expect((await del(tokenFor(ALICE), ".worker-x25519-secret")).status).toBe(400);
		expect(await env.BUCKET.get(".worker-x25519-secret")).not.toBeNull();
	});

	it("is idempotent, so a retry after a half-finished delete is safe", async () => {
		await upload("ciphertext", tokenFor(ALICE));
		expect((await del(tokenFor(ALICE))).status).toBe(200);
		expect((await del(tokenFor(ALICE))).status).toBe(200);
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

// The free tier is the only thing left between a stranger's wallet and the
// operator's R2 bill: the relay hands an upload token to ANY signed-in address
// now, registered publisher or not, so the cap has to hold here.
describe("free tier", () => {
	const OTHER = `0x${"cd".repeat(32)}` as const;

	beforeEach(() => { (env as { FREE_BYTES?: string }).FREE_BYTES = "10"; });
	afterEach(() => { delete (env as { FREE_BYTES?: string }).FREE_BYTES; });

	it("refuses an upload that would exceed the wallet's free bytes", async () => {
		expect((await upload("12345678", tokenFor(ALICE))).status).toBe(201);
		const over = await upload("345", tokenFor(ALICE), OTHER);
		expect(over.status).toBe(413);
		expect(await over.json<{ reason: string }>()).toMatchObject({ reason: "quota" });
		// Metered per owner, so one wallet filling up cannot lock out another.
		expect((await upload("12345678", tokenFor(BOB), OTHER)).status).toBe(201);
	});

	it("gives the bytes back on delete", async () => {
		await upload("12345678", tokenFor(ALICE));
		expect((await upload("1234", tokenFor(ALICE), OTHER)).status).toBe(413);
		await SELF.fetch(`https://w/upload/${RID}`, {
			method: "DELETE", headers: { Authorization: `Bearer ${tokenFor(ALICE)}` },
		});
		expect((await upload("1234", tokenFor(ALICE), OTHER)).status).toBe(201);
	});

	// Re-publishing the same file replaces bytes rather than adding them; counting
	// the new copy on top of the old would shrink the tier on every re-upload.
	it("counts an overwrite once", async () => {
		expect((await upload("12345678", tokenFor(ALICE))).status).toBe(201);
		expect((await upload("87654321", tokenFor(ALICE))).status).toBe(201);
		expect((await upload("12", tokenFor(ALICE), OTHER)).status).toBe(201);
	});

	// `usage/<owner>` is not a bytes32, which is what keeps the ungated ciphertext
	// route from serving one wallet's bill to anyone who guesses the address.
	it("does not expose the meter through /ct", async () => {
		await upload("12345678", tokenFor(ALICE));
		expect((await SELF.fetch(`https://w/ct/usage/${ALICE}`)).status).toBe(404);
	});
});
