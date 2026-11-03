import type { Address, Hex } from 'viem'
import type { Network, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types'
import { relay, RelayError, type Relay } from './relay'

// x402 v2 facilitator for buying a record. The payment is SettlementRegistry.register:
//   /verify  simulates it,  /settle  sends it.
// The 402 the seller returns (westmarch) carries, under `extra`, the record's signed terms:
//   accepts: [{ scheme: 'fangorn', network: 'eip155:84532', amount: price, asset: USDC,
//               payTo: SettlementRegistry, maxTimeoutSeconds, extra: { terms, signature } }]
// The buyer's PaymentPayload.payload is { commitment, salt, payment } (payment = the ERC-3009
// receiveWithAuthorization to the registry). After this, the buyer still sends its Semaphore
// proof to /relay/settle and asks the key server for the key.

export const SCHEME = 'fangorn'

interface Requirements {
	scheme: string
	network: string
	amount: string
	payTo: Address
	extra: { terms: { price: string }; signature: Hex }
}

interface Payload {
	accepted?: Requirements
	payload: { commitment: string; salt: Hex; payment: { from: Address } }
}

/** The register body /relay/register takes, from x402's two halves. Throws RelayError(400). */
function registerBody(payload: Payload, req: Requirements, r: Relay, network: string) {
	if (req?.scheme !== SCHEME || req.network !== network) throw new RelayError(400, `unsupported scheme or network`)
	if (req.payTo?.toLowerCase() !== r.settlementRegistry.toLowerCase()) throw new RelayError(400, 'payTo is not the SettlementRegistry')
	if (req.amount !== req.extra?.terms?.price) throw new RelayError(400, 'amount does not match the terms')
	// Free records go to /relay/register: x402 is for payments, and its limits are per buyer IP.
	if (req.amount === '0') throw new RelayError(400, 'free records need no payment: use /relay/register')
	const p = payload?.payload
	return { terms: req.extra.terms, signature: req.extra.signature, commitment: p?.commitment, salt: p?.salt, payment: p?.payment }
}

// A buyer retrying after a register that landed is already paid up.
const alreadyPaid = (e: unknown) => e instanceof RelayError && e.message === 'AlreadyRegistered'

export async function verify(body: any, r: Relay, network: Network): Promise<VerifyResponse> {
	try {
		await relay('register', registerBody(body?.paymentPayload, body?.paymentRequirements, r, network), '', r, false)
		return { isValid: true, payer: body.paymentPayload.payload.payment.from }
	} catch (e) {
		if (alreadyPaid(e)) return { isValid: true, payer: body.paymentPayload.payload.payment.from }
		if (e instanceof RelayError) return { isValid: false, invalidReason: e.message }
		throw e
	}
}

export async function settle(body: any, r: Relay, network: Network): Promise<SettleResponse> {
	const payer = body?.paymentPayload?.payload?.payment?.from
	try {
		const { tx } = await relay('register', registerBody(body?.paymentPayload, body?.paymentRequirements, r, network), '', r)
		return { success: true, transaction: tx ?? '', network, payer }
	} catch (e) {
		if (alreadyPaid(e)) return { success: true, transaction: '', network, payer }
		if (e instanceof RelayError) return { success: false, errorReason: e.message, transaction: '', network, payer }
		throw e
	}
}

// The buyer signs the treasury into its payment's nonce (registerNonce binds the referrer), so it needs it up front.
export const supported = (network: Network, treasury: Address): SupportedResponse => ({
	kinds: [{ x402Version: 2, scheme: SCHEME, network, extra: { referrer: treasury } }],
	extensions: [],
	signers: {},
})
