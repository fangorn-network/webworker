/**
 * The access worker's on-chain gate.
 *
 * The one thing worth pinning: which SettlementRegistry a read is checked against.
 * It comes from `@fangorn-network/sdk` (FangornConfig) rather than a var in
 * wrangler.toml, because the SDK is what knows which contracts belong to the current
 * deployment — a retired registry answers `isSettled: false` for every buyer who paid
 * on the live one, and nothing in the logs says so. These tests read the `to` of the
 * eth_call, which IS the deployment being gated on.
 */
import { env, SELF, fetchMock, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { keccak256, encodePacked, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FangornConfig } from "@fangorn-network/sdk/lib/config.js";
import worker from "../src/index";

const account = privateKeyToAccount(
	"0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);
const RESOURCE_ID = `0x${"11".repeat(32)}` as Hex;

/** Same packing the worker verifies — a mismatch here reads as an invalid signature. */
async function accessBody(objectKey = "tracks/audio.mp3") {
	const timestamp = Math.floor(Date.now() / 1000);
	const nullifier = "0x01";
	const msgHash = keccak256(
		encodePacked(
			["uint256", "bytes32", "string", "uint64"],
			[BigInt(nullifier), RESOURCE_ID, objectKey, BigInt(timestamp)],
		),
	);
	return {
		nullifier,
		resourceId: RESOURCE_ID,
		objectKey,
		timestamp,
		signature: await account.signMessage({ message: { raw: msgHash } }),
	};
}

const post = (body: unknown) =>
	SELF.fetch("https://example.com/access", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

/** Captures the eth_call's `to` and answers `getPrice → 0` (free, so no R2 needed). */
function stubRpc(calls: string[]) {
	const url = new URL(FangornConfig.rpcUrl);
	fetchMock
		.get(url.origin)
		.intercept({ path: url.pathname, method: "POST" })
		.reply(200, (opts: { body?: string }) => {
			calls.push(JSON.parse(opts.body ?? "{}").params[0].to);
			return { jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(64)}` };
		})
		.times(1);
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("settlement gate", () => {
	it("checks the SDK's SettlementRegistry when no address is configured", async () => {
		expect(env.SETTLEMENT_REGISTRY_ADDRESS).toBeUndefined();
		const calls: string[] = [];
		stubRpc(calls);

		await post(await accessBody());

		expect(calls[0]?.toLowerCase()).toBe(
			FangornConfig.settlementRegistryContractAddress.toLowerCase(),
		);
	});

	it("rejects a malformed override instead of falling back to the SDK", async () => {
		// An operator who typo'd an emergency repoint has to hear about it rather than
		// having a different contract silently gate the reads. No RPC interceptor here:
		// failing before any chain call is the point. Called directly rather than through
		// SELF so the override can be injected — `env` mutations do not reach SELF.
		const request = new Request("https://example.com/access", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(await accessBody()),
		});
		const res = await worker.fetch(
			request,
			{ ...env, SETTLEMENT_REGISTRY_ADDRESS: "0xnope" },
			createExecutionContext(),
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			error: "settlement registry not configured",
		});
	});
});
