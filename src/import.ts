/**
 * Turning captured movements into Wealthfolio activities.
 *
 * This is the only part of Spark that writes, and it is deliberately
 * conservative: it books what it is certain about and refuses the rest, because
 * a wrong activity is far more expensive to find and unpick later than a missing
 * one is to add.
 *
 * The symbol trap is the reason for the allow-list below. Wealthfolio resolves a
 * bare ticker against equities first: `WETH` matches **Wetouch Technology Inc.**,
 * a NASDAQ listing, and importing it would book shares of an unrelated company.
 * Only the `-USD` suffixed forms resolve to CRYPTO instruments, and every entry
 * here was checked against the live resolver rather than assumed.
 */

import type { LedgerRow } from './ledger-export'

/**
 * Chain symbol -> Wealthfolio symbol. Verified against `prepare_activity_import`:
 * each resolves to instrumentType CRYPTO with the name shown.
 *
 * Wrapped forms map to their own listing rather than the underlying, so the
 * quantity stays literally what the chain reports. Anything absent is refused,
 * which is what stops an unvetted or spoofed token being booked.
 */
export const WEALTHFOLIO_SYMBOLS: Record<string, string> = {
  ETH: 'ETH-USD', // Ethereum USD
  WETH: 'WETH-USD', // WETH USD
  USDC: 'USDC-USD', // USD Coin USD
  EURC: 'EURC-USD', // EURC USD
  XAUT: 'XAUT-USD', // Tether Gold USD
  WBTC: 'WBTC-USD', // Wrapped Bitcoin USD
  XPL: 'XPL-USD', // Plasma USD
  GHO: 'GHO-USD', // GHO USD
  BNB: 'BNB-USD', // BNB USD
  XDAI: 'XDAI-USD', // xDAI USD
  AVAX: 'AVAX-USD', // Avalanche USD
  WAVAX: 'WAVAX-USD', // Wrapped AVAX USD
  WSTETH: 'WSTETH-USD', // Lido wstETH USD
  EURe: 'EURE-USD', // Monerium EURe USD — the euro Gnosis Pay and Zeal spend
  GNO: 'GNO-USD', // Gnosis USD
  // Polygon is 'MATIC-USD', which resolves to POL28321 "Polygon (prev. MATIC)".
  // 'POL-USD' resolves to **Polkadot** — the same class of trap as WETH matching
  // "Wetouch Technology Inc.", and it would silently misprice the position.
  POL: 'MATIC-USD',
  // Deliberately NOT mapped:
  //   ARB  — 'ARB-USD' resolves to "ARbit USD", which is not obviously Arbitrum.
  //   aTokens, PT-*, variableDebt — receipt and debt tokens, not holdings.
}

/** Stablecoins whose unit price is their peg, so no price feed is needed. */
const PEGGED: Record<string, number> = { 'USDC-USD': 1 }

export type WfActivity = {
  accountId: string
  date: string
  activityType: string
  symbol: string
  quantity: number
  unitPrice: number
  currency: string
  notes: string
}

export type ImportPlan = {
  activities: WfActivity[]
  /** Rows deliberately not booked, each with the reason. Never silently dropped. */
  refused: { row: LedgerRow; reason: string }[]
}

/**
 * Wealthfolio activity type for a movement leg.
 *
 * `TRANSFER_IN`/`TRANSFER_OUT` move a quantity without touching cash, which is
 * what an internal wallet-to-wallet move actually is. `DEPOSIT`/`WITHDRAWAL` are
 * external *cash* flows and would both fail to move the position and corrupt
 * returns, so they are never used for a token movement.
 */
function activityType(row: LedgerRow): string | null {
  switch (row.kind) {
    case 'internal':
    case 'deposit':
    case 'withdrawal':
    case 'exchange-in':
    case 'exchange-out':
      return row.direction === 'in' ? 'TRANSFER_IN' : 'TRANSFER_OUT'
    case 'swap':
      return row.direction === 'in' ? 'BUY' : 'SELL'
    case 'redemption':
      // Burning a receipt token for its underlying: only the underlying arriving
      // is a real holding change, and the receipt side is refused above.
      return row.direction === 'in' ? 'TRANSFER_IN' : null
    default:
      return null
  }
}

export function planImport(
  rows: LedgerRow[],
  accountIds: Record<string, string>,
  prices: Map<string, number>,
): ImportPlan {
  const activities: WfActivity[] = []
  const refused: ImportPlan['refused'] = []

  for (const row of rows) {
    const refuse = (reason: string) => refused.push({ row, reason })

    if (row.doNotBook) {
      refuse(row.doNotBook)
      continue
    }
    const accountId = accountIds[row.account]
    if (!accountId) {
      refuse(`no Wealthfolio account id for "${row.account}"`)
      continue
    }
    const symbol = WEALTHFOLIO_SYMBOLS[row.symbol]
    if (!symbol) {
      // An unvetted symbol could be a spoof, a receipt token, or simply one
      // whose Wealthfolio listing has not been confirmed. All three are refused.
      refuse(`symbol "${row.symbol}" is not in the verified allow-list`)
      continue
    }
    const type = activityType(row)
    if (!type) {
      refuse(`no activity type for kind "${row.kind}" (${row.direction})`)
      continue
    }
    const quantity = Number(row.quantity)
    if (!(quantity > 0)) {
      refuse('zero or unparseable quantity')
      continue
    }

    const unitPrice = PEGGED[symbol] ?? prices.get(symbol)
    if (unitPrice === undefined) {
      // Booking a position at a guessed price silently corrupts cost basis, so
      // an unknown price refuses the row rather than inventing one.
      refuse(`no verified unit price for ${symbol} on ${row.date}`)
      continue
    }

    activities.push({
      accountId,
      date: row.date,
      activityType: type,
      symbol,
      quantity,
      unitPrice,
      currency: 'USD',
      // The chain identity travels with the activity, so a row in Wealthfolio can
      // always be traced back to the transaction that produced it.
      notes: `spark ${row.chainId}:${row.txHash}:${row.logIndex} ${row.kind}`,
    })
  }

  return { activities, refused }
}
