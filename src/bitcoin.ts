/**
 * Bitcoin wallet scanning, from a watch-only extended public key.
 *
 * Bitcoin has no accounts: a wallet is a stream of derived addresses, each
 * typically used once. So "where did the money go" cannot be answered by looking
 * up a balance — the addresses have to be derived, then each one asked.
 *
 * Derivation is BIP84 (native segwit, `bc1q…`), which is what a `zpub` denotes.
 * Scanning follows the BIP44 gap limit: keep deriving until 20 consecutive
 * addresses have never been used, because stopping at the first unused one would
 * miss everything after a gap.
 *
 * mempool.space serves all of this without a key.
 */

import { HDKey } from '@scure/bip32'
import { base58check, bech32 } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'

const b58 = base58check(sha256)

/**
 * `zpub` and `xpub` differ only in a 4-byte version prefix; the key material is
 * identical. Re-badging it as `xpub` is what lets a standard BIP32 parser read
 * it — the alternative is teaching the parser every wallet vendor's prefix.
 */
export function zpubToXpub(zpub: string): string {
  const raw = b58.decode(zpub)
  const out = new Uint8Array(raw.length)
  out.set(raw)
  out.set([0x04, 0x88, 0xb2, 0x1e], 0) // xpub
  return b58.encode(out)
}

/** P2WPKH address for a compressed public key. */
export function p2wpkh(pubkey: Uint8Array): string {
  const hash = ripemd160(sha256(pubkey))
  return bech32.encode('bc', [0, ...bech32.toWords(hash)])
}

export type BtcAddress = {
  address: string
  path: string
  txCount: number
  received: number
  sent: number
  balance: number
}

/**
 * Both hosts speak the same Esplora API, and both rate-limit a scan that walks
 * a wallet address by address. Alternating between them with a growing backoff
 * is what gets a full derivation through without a key.
 */
const HOSTS = ['https://mempool.space/api', 'https://blockstream.info/api']

const api = async (path: string): Promise<any> => {
  let last = ''
  for (let attempt = 0; attempt < 8; attempt++) {
    const host = HOSTS[attempt % HOSTS.length]!
    try {
      const res = await fetch(`${host}${path}`, { signal: AbortSignal.timeout(25000) })
      if (res.ok) return await res.json()
      last = `HTTP ${res.status}`
    } catch (err) {
      last = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** Math.floor(attempt / 2)))
  }
  throw new Error(`esplora failed (${last}): ${path}`)
}

/** Derives and scans a chain (0 = receive, 1 = change) until the gap limit. */
export async function scanChain(xpub: string, change: 0 | 1, gapLimit = 20): Promise<BtcAddress[]> {
  const root = HDKey.fromExtendedKey(xpub).deriveChild(change)
  const found: BtcAddress[] = []
  let gap = 0
  for (let i = 0; gap < gapLimit; i++) {
    const address = p2wpkh(root.deriveChild(i).publicKey!)
    const info = await api(`/address/${address}`)
    const c = info.chain_stats
    const m = info.mempool_stats
    const received = (c.funded_txo_sum + m.funded_txo_sum) / 1e8
    const sent = (c.spent_txo_sum + m.spent_txo_sum) / 1e8
    const txCount = c.tx_count + m.tx_count
    if (txCount === 0) gap++
    else {
      gap = 0
      found.push({ address, path: `m/${change}/${i}`, txCount, received, sent, balance: received - sent })
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  return found
}

export type BtcTx = {
  txid: string
  time: number
  /** Signed: positive is received by the wallet, negative is spent. */
  delta: number
  fee: number
}

/** Every transaction touching the wallet, netted per transaction. */
export async function walletTransactions(addresses: string[]): Promise<BtcTx[]> {
  const mine = new Set(addresses)
  const byTx = new Map<string, BtcTx>()
  for (const address of addresses) {
    for (const t of await api(`/address/${address}/txs`)) {
      if (byTx.has(t.txid)) continue
      let delta = 0
      for (const vin of t.vin) {
        const a = vin.prevout?.scriptpubkey_address
        if (a && mine.has(a)) delta -= vin.prevout.value / 1e8
      }
      for (const vout of t.vout) {
        if (vout.scriptpubkey_address && mine.has(vout.scriptpubkey_address)) delta += vout.value / 1e8
      }
      byTx.set(t.txid, {
        txid: t.txid,
        time: t.status?.block_time ?? 0,
        delta,
        fee: (t.fee ?? 0) / 1e8,
      })
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  return [...byTx.values()].sort((a, b) => a.time - b.time)
}
