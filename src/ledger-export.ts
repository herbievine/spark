/**
 * The money-movement ledger: one auditable row per leg, as CSV or JSON.
 *
 * Deliberately verbose. Every row carries the evidence needed to check it
 * independently — chain, block, transaction hash, log index, both addresses, the
 * raw integer value as well as the scaled one — so any figure can be traced back
 * to the chain rather than taken on trust.
 *
 * `rawValue` is the authority. Token amounts routinely exceed the precision of a
 * double (USDC has 6 decimals, most tokens 18), so `quantity` is a convenience
 * for reading and `rawValue` is what reconciles.
 */

import { SparkState } from './state'
import { chainById } from './chains'
import { KNOWN_COUNTERPARTIES, VENUE_LABELS } from './config'
import { KNOWN_EXCHANGES } from './counterparties'
import { classify, type Movement } from './movements'

export type LedgerRow = {
  date: string
  time: string
  chain: string
  chainId: number
  account: string
  /** Movement classification: internal, swap, redemption, deposit, … */
  kind: string
  direction: 'in' | 'out'
  symbol: string
  quantity: string
  rawValue: string
  decimals: number
  contract: string
  counterparty: string
  counterpartyLabel: string
  txHash: string
  logIndex: number
  blockNumber: number
  /** Set when the row should NOT be booked into Wealthfolio, with the reason. */
  doNotBook: string
  note: string
}

const label = (address: string, book: Map<string, string>): string =>
  book.get(address) ??
  KNOWN_COUNTERPARTIES[address] ??
  VENUE_LABELS[address] ??
  KNOWN_EXCHANGES[address] ??
  (address === '0x0000000000000000000000000000000000000000' ? 'burn/mint' : '')

/**
 * Rows that must never reach Wealthfolio, and why. A spoofed transfer moved no
 * value, and dust from an impersonating address is an attack rather than income;
 * booking either would invent a movement that never happened.
 */
/**
 * Airdrop spam advertises itself: the token's own symbol carries a URL, a
 * "visit"/"claim" instruction, or non-ASCII characters used to imitate a real
 * ticker. Legitimate tickers are short and ASCII.
 */
const SPAM_SYMBOL =
  // A real ticker is short, ASCII, and has no punctuation beyond - and .
  // Anything carrying a URL, a slash, whitespace, or an instruction is an advert
  // painted into the token's own name. Matching structure rather than a TLD list
  // avoids the whack-a-mole that let "t.me/s/…" through.
  /[\/\s()]|https?:|www\.|\.[a-z]{2,}|visit|claim|reward|airdrop|bonus|free|_/i

function bookingBlock(kind: string, symbol: string): string {
  if (kind === 'spoof') return 'forged Transfer event — no value moved'
  if (kind === 'dust-attack') return 'address-poisoning dust — not income'
  if (SPAM_SYMBOL.test(symbol)) return 'advertising spam token — symbol contains a URL or instruction'
  if (/[^\x00-\x7F]/.test(symbol)) return 'non-ASCII symbol — homoglyph impersonation'
  return ''
}

/**
 * An unvetted token that only ever arrived, never left, and is not in the
 * registry is an unsolicited airdrop. Real holdings get spent, swapped or at
 * least registered; airdrops accumulate in one direction and are never touched.
 */
function inboundOnlyUnvetted(rows: LedgerRow[]): Set<string> {
  const seen = new Map<string, { in: boolean; out: boolean }>()
  for (const r of rows) {
    if (!r.symbol.endsWith('?')) continue
    const e = seen.get(r.symbol) ?? { in: false, out: false }
    if (r.direction === 'in') e.in = true
    else e.out = true
    seen.set(r.symbol, e)
  }
  return new Set([...seen].filter(([, e]) => e.in && !e.out).map(([s]) => s))
}

export function buildLedger(
  state: SparkState,
  book: { name: string; address: string }[],
  opts: { year?: number; limit?: number } = {},
): LedgerRow[] {
  const byAddress = new Map<string, string>()
  for (const b of book) if (!byAddress.has(b.address.toLowerCase())) byAddress.set(b.address.toLowerCase(), b.name)

  const movements: Movement[] = classify(state, book, opts.limit ?? 100000)
  const transfers = state.recentTransfers(opts.limit ?? 100000)

  // Movements carry the interpretation; transfers carry the evidence. Joining
  // them keeps both in one row rather than making them cross-reference.
  const kindByTx = new Map<string, Movement>()
  for (const m of movements) kindByTx.set(`${m.chainId}:${m.txHash.toLowerCase()}:${m.account}`, m)

  const rows: LedgerRow[] = []

  for (const t of transfers) {
    const when = new Date(t.blockTime * 1000)
    if (opts.year && when.getUTCFullYear() !== opts.year) continue

    const from = byAddress.get(t.fromAddr)
    const to = byAddress.get(t.toAddr)

    // A transfer between two tracked accounts is two legs, one per account, so
    // each account's own ledger balances on its own.
    for (const [account, direction] of [
      [from, 'out'],
      [to, 'in'],
    ] as const) {
      if (!account) continue

      const counterparty = direction === 'out' ? t.toAddr : t.fromAddr
      const movement = kindByTx.get(`${t.chainId}:${t.txHash.toLowerCase()}:${account}`)
      const kind = movement?.kind ?? (direction === 'in' ? 'deposit' : 'withdrawal')

      rows.push({
        date: when.toISOString().slice(0, 10),
        time: when.toISOString().slice(11, 19),
        chain: chainById(t.chainId)?.name ?? String(t.chainId),
        chainId: t.chainId,
        account,
        kind,
        direction,
        symbol: t.symbol,
        quantity: String(Number(t.rawValue) / 10 ** t.decimals),
        rawValue: t.rawValue,
        decimals: t.decimals,
        contract: t.contract ?? 'native',
        counterparty,
        counterpartyLabel: label(counterparty, byAddress),
        txHash: t.txHash,
        logIndex: t.logIndex,
        blockNumber: t.blockNumber,
        doNotBook: bookingBlock(kind, t.symbol),
        note: movement?.note ?? '',
      })
    }
  }

  // Second pass: an unvetted token that only ever arrived is an airdrop. This
  // needs the whole set, so it cannot be decided row by row above.
  const airdrops = inboundOnlyUnvetted(rows)
  for (const r of rows) {
    if (!r.doNotBook && airdrops.has(r.symbol)) {
      r.doNotBook = 'unsolicited airdrop — unregistered token, only ever received'
    }
  }

  return rows.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))
}

const csvCell = (v: unknown): string => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: LedgerRow[]): string {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0]!) as (keyof LedgerRow)[]
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\n')
}

/** Per-account, per-asset net movement — the summary that answers "where did it go". */
export function summarise(rows: LedgerRow[]): string {
  const net = new Map<string, { in: number; out: number; n: number }>()
  for (const r of rows) {
    if (r.doNotBook) continue // never let forged or hostile rows into a total
    const key = `${r.account}|${r.symbol}`
    const e = net.get(key) ?? { in: 0, out: 0, n: 0 }
    const q = Number(r.quantity)
    if (r.direction === 'in') e.in += q
    else e.out += q
    e.n++
    net.set(key, e)
  }

  const out = ['ACCOUNT / ASSET            IN              OUT             NET          LEGS']
  for (const [key, e] of [...net].sort()) {
    const [account, symbol] = key.split('|')
    out.push(
      `${(account + ' / ' + symbol).padEnd(26)} ${e.in.toFixed(6).padStart(15)} ${e.out
        .toFixed(6)
        .padStart(15)} ${(e.in - e.out).toFixed(6).padStart(15)} ${String(e.n).padStart(5)}`,
    )
  }
  return out.join('\n')
}
