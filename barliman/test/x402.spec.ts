import { env } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { ContractFunctionRevertedError, type Abi, type Address, type Hex } from 'viem'
import type { Call, Relay } from '../src/relay'
import { settle, verify } from '../src/x402'

const NETWORK = 'eip155:84532'
const TREASURY = '0x00000000000000000000000000000000000000fe' as Address
const REGISTRY = '0x00000000000000000000000000000000000000e0' as Address
const BUYER = '0x1111111111111111111111111111111111111111' as Address
const H = (b: string) => `0x${b.repeat(32)}` as Hex

function fakeChain(revert?: string) {
	const sent: Call[] = []
	return {
		sent,
		simulate: async (call: Call) => {
			if (revert) throw new ContractFunctionRevertedError({ abi: call.abi as Abi, functionName: call.functionName, message: revert })
			return call
		},
		send: async (request: unknown) => (sent.push(request as Call), H('ab')),
	}
}

const relayWith = (chain: ReturnType<typeof fakeChain>): Relay => ({
	chain,
	kv: env.RATE_KV,
	treasury: TREASURY,
	dataRegistry: '0x00000000000000000000000000000000000000d0',
	settlementRegistry: REGISTRY,
})

/** What westmarch's 402 and the buyer's payment would carry, for a record priced 10000. */
const body = (over: Record<string, unknown> = {}) => {
	const requirements = {
		scheme: 'fangorn',
		network: NETWORK,
		amount: '10000',
		payTo: REGISTRY,
		extra: {
			terms: { publisher: BUYER, repo: H('22'), key: H('33'), price: '10000', shareBps: 500, generation: '0', deadline: '2000000000' },
			signature: '0x1234',
		},
		...over,
	}
	return {
		paymentRequirements: requirements,
		paymentPayload: {
			x402Version: 2,
			accepted: requirements,
			payload: {
				commitment: '42',
				salt: H('44'),
				payment: { from: BUYER, value: '10000', validAfter: '0', validBefore: '2000000000', nonce: H('55'), v: 27, r: H('66'), s: H('77') },
			},
		},
	}
}

describe('x402 facilitator', () => {
	it('verify simulates register and sends nothing', async () => {
		const chain = fakeChain()
		expect(await verify(body(), relayWith(chain), NETWORK)).toEqual({ isValid: true, payer: BUYER })
		expect(chain.sent).toHaveLength(0)
	})

	it('settle sends register, with the treasury as referrer', async () => {
		const chain = fakeChain()
		expect(await settle(body(), relayWith(chain), NETWORK)).toMatchObject({ success: true, transaction: H('ab'), network: NETWORK })
		expect(chain.sent[0].functionName).toBe('register')
		expect(chain.sent[0].args[3]).toBe(TREASURY)
	})

	it('refuses requirements that do not match the terms or the registry', async () => {
		const chain = fakeChain()
		expect(await verify(body({ amount: '1' }), relayWith(chain), NETWORK)).toMatchObject({ isValid: false })
		expect(await verify(body({ payTo: TREASURY }), relayWith(chain), NETWORK)).toMatchObject({ isValid: false })
		expect(await verify(body({ scheme: 'exact' }), relayWith(chain), NETWORK)).toMatchObject({ isValid: false })
	})

	it('returns the revert reason and sends nothing', async () => {
		const chain = fakeChain('StaleTerms')
		expect(await settle(body(), relayWith(chain), NETWORK)).toMatchObject({ success: false, errorReason: 'StaleTerms' })
		expect(chain.sent).toHaveLength(0)
	})

	it('treats an earlier register as paid, so a retry succeeds', async () => {
		const chain = fakeChain('AlreadyRegistered')
		expect(await verify(body(), relayWith(chain), NETWORK)).toMatchObject({ isValid: true })
		expect(await settle(body(), relayWith(chain), NETWORK)).toMatchObject({ success: true })
	})
})
