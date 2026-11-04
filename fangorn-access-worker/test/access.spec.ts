import { describe, it, expect } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { buildAccessRequest, deriveRecordKey, makeDeposit, newRepoKey, statement } from '@fangorn-network/sdk/lib/crypto/paid.js'
import { WHOLE_REPO, recordKey } from '@fangorn-network/sdk/lib/contracts/settlement-registry/index.js'
import { unseal } from '@fangorn-network/sdk/lib/crypto/encryption.js'
import { serveAccess, verifyAccessRequest } from '../src/access'

const REGISTRY = '0x00000000000000000000000000000000000000aa' as Address
const publisher = privateKeyToAccount(generatePrivateKey())
const reader = privateKeyToAccount(generatePrivateKey())
const scope = { chainId: 84532, registry: REGISTRY, publisher: publisher.address, repo: `0x${'cd'.repeat(32)}` as Hex, generation: 0n }
const KEY_A = recordKey('a')
const KEY_B = recordKey('b')

const secret = x25519.utils.randomSecretKey()
const kRepo = newRepoKey()
const deposit = makeDeposit({ kRepo, keyServerPubkey: x25519.getPublicKey(secret), keyServer: 'https://w', scope })
const replySecret = x25519.utils.randomSecretKey()
const readerKey = bytesToHex(x25519.getPublicKey(replySecret))
const at = { chainId: scope.chainId, registry: REGISTRY }

/** A key server where `reader` has bought record A only. */
const ks = {
	...at,
	secret,
	canRead: async (r: Address, _p: Address, _repo: Hex, key: Hex) => r === reader.address && key === KEY_A,
}
const ask = (key: Hex, signer = reader, d = deposit) => buildAccessRequest({ signer, deposit: d, key, readerKey })
const open = (sealed: Hex) => unseal(hexToBytes(sealed), replySecret, statement(scope))

describe('verifyAccessRequest', () => {
	it('recovers the signer', async () => {
		expect(await verifyAccessRequest(await ask(KEY_A), at)).toBe(reader.address)
	})

	it('recovers someone else when a signed field, the chain or the registry changes', async () => {
		const req = await ask(KEY_A)
		for (const [body, where] of [
			[{ ...req, key: KEY_B }, at],
			[{ ...req, generation: '1' }, at],
			[{ ...req, publisher: reader.address }, at],
			[{ ...req, readerKey: `0x${'00'.repeat(32)}` as Hex }, at],
			[req, { ...at, chainId: 1 }],
		] as const) {
			expect(await verifyAccessRequest(body, where).catch(() => null)).not.toBe(reader.address)
		}
	})

	it('refuses a stale timestamp', async () => {
		const req = await buildAccessRequest({ signer: reader, deposit, key: KEY_A, readerKey, timestamp: 1000 })
		await expect(verifyAccessRequest(req, { ...at, now: 1061 })).rejects.toMatchObject({ status: 400 })
		expect(await verifyAccessRequest(req, { ...at, now: 1060 })).toBe(reader.address)
	})
})

describe('serveAccess', () => {
	it('gives a buyer the record key they paid for, and nothing else', async () => {
		const { sealed } = await serveAccess(await ask(KEY_A), ks)
		expect(open(sealed)).toEqual(deriveRecordKey(kRepo, statement(scope), KEY_A))
		await expect(serveAccess(await ask(KEY_B), ks)).rejects.toMatchObject({ status: 403 })
		await expect(serveAccess(await ask(WHOLE_REPO), ks)).rejects.toMatchObject({ status: 403 })
	})

	it('gives the publisher its repo key without buying', async () => {
		const { sealed } = await serveAccess(await ask(WHOLE_REPO, publisher), ks)
		expect(open(sealed)).toEqual(kRepo)
	})

	it('refuses a deposit made for another repo', async () => {
		const other = makeDeposit({ kRepo, keyServerPubkey: x25519.getPublicKey(secret), keyServer: 'https://w', scope: { ...scope, repo: `0x${'ab'.repeat(32)}` as Hex } })
		await expect(serveAccess(await ask(KEY_A, reader, { ...deposit, sealed: other.sealed }), ks)).rejects.toMatchObject({ status: 400 })
	})
})
