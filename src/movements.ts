/**
 * Interpretation of captured transfers.
 *
 * Kept separate from capture so it can be re-run and improved at any time
 * against stored rows. Capture is irreversible; classification is not.
 *
 * The unit of classification is the **transaction**, not the transfer. A single
 * transfer is ambiguous — it could be an internal move, a swap leg, a bridge leg
 * or a real external flow. Netting every transfer in one transaction resolves
 * most of that ambiguity without decoding any protocol: if one asset leaves and
 * another arrives in the same transaction, it is a swap, and the ratio is the
 * execution price. That works identically for Uniswap, CoW and anything else,
 * with no per-DEX adapter to maintain.
 */

import { SparkState, type TransferRow } from './state'
import { chainById } from './chains'
import { KNOWN_COUNTERPARTIES, VENUE_LABELS } from './config'
import { KNOWN_EXCHANGES } from './counterparties'

export type MovementKind =
  | 'internal' // between two accounts Spark tracks
  | 'swap' // different assets in and out of the same transaction
  | 'redemption' // a wrapper or receipt token burned for its underlying
  | 'deposit' // value arriving from outside
  | 'withdrawal' // value leaving to outside
  | 'exchange-in' // arriving from a known exchange
  | 'exchange-out' // sent to a known exchange
  | 'dust-attack' // unsolicited dust from an address impersonating a known one
  | 'spoof' // forged: a hostile contract emitted a Transfer naming your address

export type Movement = {
  chain: string
  chainId: number
  txHash: string
  at: string
  kind: MovementKind
  account: string
  /** Signed per asset: negative left the account, positive arrived. */
  legs: { symbol: string; amount: number; counterparty: string }[]
  note?: string
}

const scale = (row: TransferRow) => Number(row.rawValue) / 10 ** row.decimals

const BURN = '0x0000000000000000000000000000000000000000'

/**
 * Symbols containing non-ASCII characters are impersonation attempts: real
 * tickers are ASCII, while attackers use Unicode homoglyphs to imitate them
 * (a fake WBTC seen here spelled itself with Lisu and Cherokee letters that
 * render identically to Latin ones).
 */
const isHomoglyph = (symbol: string) => /[^\x00-\x7F]/.test(symbol)

/**
 * Address poisoning: an attacker sends dust from an address sharing the victim's
 * leading and trailing characters, so it can be mistaken for the real one when
 * copied out of a transaction history. Detected by comparing against every known
 * address rather than by value, because the amount is arbitrary.
 */
function looksLike(candidate: string, known: string[]): string | null {
  const c = candidate.toLowerCase()
  for (const k of known) {
    const target = k.toLowerCase()
    if (c === target) continue
    if (c.slice(0, 6) === target.slice(0, 6) && c.slice(-4) === target.slice(-4)) return k
  }
  return null
}

export function classify(
  state: SparkState,
  book: { name: string; address: string }[],
  limit = 500,
): Movement[] {
  // Hyperliquid shares the Nano X address, so a naive map would let the venue
  // overwrite the wallet and label every Nano X movement "Hyperliquid". On-chain
  // movements belong to the wallet; the venue is reached via its bridge.
  const byAddress = new Map<string, string>()
  for (const b of book) if (!byAddress.has(b.address.toLowerCase())) byAddress.set(b.address.toLowerCase(), b.name)
  for (const [address, name] of Object.entries(KNOWN_COUNTERPARTIES)) byAddress.set(address.toLowerCase(), name)
  const known = book.map((b) => b.address)
  const rows = state.recentTransfers(limit)

  // One transaction can carry many transfers; they are only meaningful together.
  const byTx = new Map<string, TransferRow[]>()
  for (const row of rows) {
    const key = `${row.chainId}:${row.txHash}`
    byTx.set(key, [...(byTx.get(key) ?? []), row])
  }

  const movements: Movement[] = []

  for (const [, group] of byTx) {
    const first = group[0]!
    const chain = chainById(first.chainId)?.name ?? String(first.chainId)
    const at = new Date(first.blockTime * 1000).toISOString()

    // Which tracked *addresses* this transaction touched. Keyed by address, not
    // by account name: Hyperliquid's book entry carries the Nano X address, so
    // resolving a name back to an address would attribute the bridge's side of
    // the transfer to the wrong wallet.
    const touched = new Set<string>()
    for (const row of group) {
      if (byAddress.has(row.fromAddr)) touched.add(row.fromAddr)
      if (byAddress.has(row.toAddr)) touched.add(row.toAddr)
    }

    for (const address of touched) {
      const account = byAddress.get(address)!
      const legs: Movement['legs'] = []
      let counterpartyOutside = ''

      for (const row of group) {
        const amount = scale(row)
        if (row.fromAddr === address) {
          legs.push({ symbol: row.symbol, amount: -amount, counterparty: row.toAddr })
          if (!byAddress.has(row.toAddr)) counterpartyOutside = row.toAddr
        } else if (row.toAddr === address) {
          legs.push({ symbol: row.symbol, amount, counterparty: row.fromAddr })
          if (!byAddress.has(row.fromAddr)) counterpartyOutside = row.fromAddr
        }
      }
      if (!legs.length) continue

      const symbols = new Set(legs.map((l) => l.symbol))
      const hasIn = legs.some((l) => l.amount > 0)
      const hasOut = legs.some((l) => l.amount < 0)
      const bothTracked = legs.every((l) => byAddress.has(l.counterparty))

      let kind: MovementKind
      let note: string | undefined

      // A contract can emit a Transfer event naming any address, so an
      // unregistered token claiming your address moved funds proves nothing. If
      // the transaction also involves a lookalike address, it is a forgery and
      // no value actually moved — booking it would invent a movement.
      const forged = legs.some(
        (l) =>
          (l.symbol.startsWith('UNKNOWN:') || isHomoglyph(l.symbol)) &&
          (looksLike(l.counterparty, known) !== null || isHomoglyph(l.symbol)),
      )

      const burned = legs.find((l) => l.amount < 0 && l.counterparty === BURN)

      if (forged) {
        kind = 'spoof'
        note = 'forged Transfer event from a hostile contract — no value moved, do not book'
      } else if (burned && hasIn && symbols.size > 1) {
        // Burning a receipt token and receiving its underlying from that same
        // token's contract is a redemption, not a trade. The difference is
        // accrued interest, and booking it as a swap would record a bogus rate
        // and lose the income.
        kind = 'redemption'
        const into = legs.find((l) => l.amount > 0)!
        const gain = into.amount - Math.abs(burned.amount)
        note =
          `burned ${Math.abs(burned.amount)} ${burned.symbol} -> ${into.amount} ${into.symbol}; ` +
          `${gain > 0 ? '+' : ''}${Number(gain.toPrecision(8))} ${into.symbol} accrued interest`
      } else if (hasIn && hasOut && symbols.size > 1) {
        kind = 'swap'
        const out = legs.find((l) => l.amount < 0)!
        const into = legs.find((l) => l.amount > 0)!
        // The transaction is the price. No oracle involved, so no disagreement
        // with Wealthfolio's own market data is possible.
        note = `rate ${Math.abs(into.amount / out.amount).toFixed(6)} ${into.symbol}/${out.symbol}`
      } else if (bothTracked) {
        kind = 'internal'
      } else if (KNOWN_EXCHANGES[counterpartyOutside] || VENUE_LABELS[counterpartyOutside]) {
        // A named venue, not an anonymous flow. Booking a transfer to your own
        // exchange account as WITHDRAWAL would report it as money leaving the
        // portfolio and corrupt every return figure.
        const venue = KNOWN_EXCHANGES[counterpartyOutside] ?? VENUE_LABELS[counterpartyOutside]!
        kind = hasIn ? 'exchange-in' : 'exchange-out'
        note = `counterparty is ${venue}`
      } else if (hasIn) {
        const impersonated = looksLike(counterpartyOutside, known)
        if (impersonated) {
          kind = 'dust-attack'
          note = `sender impersonates ${byAddress.get(impersonated.toLowerCase()) ?? impersonated} — do not reuse this address`
        } else {
          kind = 'deposit'
        }
      } else {
        kind = 'withdrawal'
      }

      const unknown = legs.filter((l) => l.symbol.startsWith('UNKNOWN:'))
      if (unknown.length) {
        // The Wealthfolio API cannot create assets, so an unregistered token can
        // never be booked. It must surface, not be quietly dropped.
        note = `${note ? note + '; ' : ''}unregistered token ${unknown.map((u) => u.symbol).join(', ')}`
      }

      movements.push({ chain, chainId: first.chainId, txHash: first.txHash, at, kind, account, legs, note })
    }
  }

  return movements.sort((a, b) => b.at.localeCompare(a.at))
}

export function renderMovements(movements: Movement[]): string {
  if (!movements.length) return 'No movements captured yet.'
  const out: string[] = [`Spark movements — ${movements.length} classified`, '']
  for (const m of movements) {
    const legs = m.legs
      .map((l) => `${l.amount > 0 ? '+' : ''}${Number(l.amount.toPrecision(8))} ${l.symbol}`)
      .join(' ')
    out.push(`${m.at.slice(0, 16)}  ${m.kind.padEnd(11)} ${m.account.padEnd(16)} ${m.chain.padEnd(9)} ${legs}`)
    if (m.note) out.push(`${' '.repeat(18)}${m.note}`)
  }
  return out.join('\n')
}
