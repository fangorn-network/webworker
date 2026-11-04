import { env, SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { FangornConfig } from '@fangorn-network/sdk/lib/config.js'
import { buildAccessRequest, makeDeposit, newRepoKey, statement } from '@fangorn-network/sdk/lib/crypto/paid.js'
import { WHOLE_REPO } from '@fangorn-network/sdk/lib/contracts/settlement-registry/index.js'
import { unseal } from '@fangorn-network/sdk/lib/crypto/encryption.js'

const SECRET = `0x${'5e'.repeat(32)}` as Hex

beforeEach(() => {
	;(env as { WORKER_X25519_SECRET?: string }).WORKER_X25519_SECRET = SECRET
})

const post = (body: unknown) =>
	SELF.fetch('https://w/access', { method: 'POST', body: JSON.stringify(body) })

describe('key server', () => {
	it('serves the pubkey of its secret', async () => {
		const { pubkey } = (await (await SELF.fetch('https://w/pubkey')).json()) as { pubkey: Hex }
		expect(pubkey).toBe(bytesToHex(x25519.getPublicKey(hexToBytes(SECRET))))
	})

	it('refuses a malformed request with 400', async () => {
		expect((await post({ publisher: 'nope' })).status).toBe(400)
	})

	// The publisher path skips the chain, so this runs offline.
	it('gives the publisher its own repo key back', async () => {
		const publisher = privateKeyToAccount(generatePrivateKey())
		const scope = {
			chainId: FangornConfig.chain.id,
			registry: FangornConfig.settlementRegistryContractAddress!,
			publisher: publisher.address,
			repo: `0x${'cd'.repeat(32)}` as Hex,
			generation: 0n,
		}
		const kRepo = newRepoKey()
		const deposit = makeDeposit({ kRepo, keyServerPubkey: x25519.getPublicKey(hexToBytes(SECRET)), keyServer: 'https://w', scope })
		const reader = x25519.utils.randomSecretKey()
		const req = await buildAccessRequest({
			signer: publisher,
			deposit,
			key: WHOLE_REPO,
			readerKey: bytesToHex(x25519.getPublicKey(reader)),
		})

		const res = await post(req)
		expect(res.status).toBe(200)
		const { sealed } = (await res.json()) as { sealed: Hex }
		expect(unseal(hexToBytes(sealed), reader, statement(scope))).toEqual(kRepo)
	})
})
