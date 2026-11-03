import { bytesToHex, hexToBytes, recoverMessageAddress, type Address, type Hex } from 'viem'
import { accessMessage, deriveRecordKey, statement, type AccessRequest } from '@fangorn-network/sdk/lib/crypto/paid.js'
import { seal, unseal } from '@fangorn-network/sdk/lib/crypto/encryption.js'
import { WHOLE_REPO } from '@fangorn-network/sdk/lib/contracts/settlement-registry/index.js'

/** A refusal, with its HTTP status. */
export class AccessError extends Error {
	constructor(
		readonly status: 400 | 403,
		message: string,
	) {
		super(message)
	}
}

/** Seconds a request's timestamp may be off from our clock. */
export const ACCESS_WINDOW = 60

export interface KeyServer {
	secret: Uint8Array
	chainId: number
	registry: Address
	canRead(reader: Address, publisher: Address, repo: Hex, key: Hex): Promise<boolean>
	now?: number
}

/** Who signed the request. Uses our own chain and registry, so a request made for another deployment recovers a different address. */
export async function verifyAccessRequest(body: AccessRequest, at: Pick<KeyServer, 'chainId' | 'registry' | 'now'>): Promise<Address> {
	const now = at.now ?? Math.floor(Date.now() / 1000)
	if (Math.abs(now - body.timestamp) > ACCESS_WINDOW) throw new AccessError(400, 'stale timestamp')
	const stmt = statement({ ...at, publisher: body.publisher, repo: body.repo, generation: BigInt(body.generation) })
	try {
		return await recoverMessageAddress({
			message: { raw: accessMessage(stmt, body.key, body.readerKey, body.timestamp) },
			signature: body.signature,
		})
	} catch {
		throw new AccessError(400, 'bad signature')
	}
}

/**
 * Returns the record key (or the repo key, for WHOLE_REPO) sealed to the reader's key,
 * if the reader is the publisher or canRead says yes.
 * `sealed` isn't signed; swapping in another deposit only works if it was made for this same repo and generation.
 */
export async function serveAccess(body: AccessRequest, ks: KeyServer): Promise<{ sealed: Hex }> {
	const reader = await verifyAccessRequest(body, ks)
	const own = reader.toLowerCase() === body.publisher.toLowerCase()
	if (!own && !(await ks.canRead(reader, body.publisher, body.repo, body.key))) throw new AccessError(403, 'not settled')
	const stmt = statement({ ...ks, publisher: body.publisher, repo: body.repo, generation: BigInt(body.generation) })
	let kRepo: Uint8Array
	try {
		kRepo = unseal(hexToBytes(body.sealed), ks.secret, stmt)
	} catch {
		throw new AccessError(400, 'deposit was not made for this repo, generation and registry')
	}
	const out = body.key === WHOLE_REPO ? kRepo : deriveRecordKey(kRepo, stmt, body.key)
	return { sealed: bytesToHex(seal(out, hexToBytes(body.readerKey), stmt)) }
}
