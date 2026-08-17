/**
 * Builds the Wealthfolio import plan from the ledger.
 *
 * Every rule here was paid for with a wrong import, so each is load-bearing:
 *
 * - **Real timestamps, not dates.** A bare date lands at midnight, so every row
 *   on a day shares an instant and Wealthfolio cannot order a disposal after its
 *   acquisition — it clamps the disposal against a zero balance and invents money.
 * - **Net within a transaction.** Legs of one transaction share an instant by
 *   definition, so the same ambiguity applies and cannot be fixed with ordering.
 *   A transaction is atomic, so netting it loses nothing real.
 * - **Merge same-day identical rows.** Wealthfolio fingerprints duplicates on the
 *   calendar day, so two identical rows on one day collapse and the second is
 *   silently skipped — dropping one leg of a pair and unbalancing the account.
 * - **Refuse rather than guess.** An unverified symbol or an unknown price skips
 *   the row. A wrong asset or a guessed cost basis is far more expensive to find
 *   later than a missing row is to add.
 */

import type { LedgerRow } from './ledger-export'
import { WEALTHFOLIO_SYMBOLS } from './import'

export type PlanRow = {
  accountId: string
  /** ISO instant. Never a bare date — see the ordering note above. */
  date: string
  activityType: 'TRANSFER_IN' | 'TRANSFER_OUT'
  symbol: string
  quantity: number
  unitPrice: number
  currency: 'USD'
}

export type PlanInput = {
  rows: LedgerRow[]
  accountIds: Record<string, string>
  /** Opening quantity per `account|chainSymbol`, as of `openingDate`. */
  openings: Record<string, number>
  openingDate: string
  /** Price per `WF_SYMBOL|YYYY-MM-DD`, plus `WF_SYMBOL` as a fallback. */
  prices: Record<string, number>
}

export type PlanResult = {
  rows: PlanRow[]
  skipped: { reason: string; count: number }[]
}

const priceFor = (prices: Record<string, number>, symbol: string, day: string): number | undefined =>
  prices[`${symbol}|${day}`] ?? (symbol === 'USDC-USD' ? 1 : prices[symbol])

export function buildPlan(input: PlanInput): PlanResult {
  const { rows, accountIds, openings, openingDate, prices } = input
  const skipped = new Map<string, number>()
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1)

  // 1. Opening positions. A synthetic baseline rather than an event, so a plain
  //    date is correct here — there is nothing for it to be ordered against.
  const out: PlanRow[] = []
  for (const [key, quantity] of Object.entries(openings)) {
    if (quantity <= 0) continue
    const [account, chainSymbol] = key.split('|') as [string, string]
    const accountId = accountIds[account]
    const symbol = WEALTHFOLIO_SYMBOLS[chainSymbol]
    if (!accountId || !symbol) { skip(`opening: no account or symbol for ${key}`); continue }
    const unitPrice = priceFor(prices, symbol, openingDate)
    if (unitPrice === undefined) { skip(`opening: no price for ${symbol}`); continue }
    out.push({ accountId, date: openingDate, activityType: 'TRANSFER_IN', symbol, quantity, unitPrice, currency: 'USD' })
  }

  // 2. Movements, netted per transaction.
  const perTx = new Map<string, { row: LedgerRow; symbol: string; accountId: string; net: number }>()
  for (const r of rows) {
    if (r.doNotBook) { skip('doNotBook'); continue }
    const accountId = accountIds[r.account]
    const symbol = WEALTHFOLIO_SYMBOLS[r.symbol]
    if (!accountId) { skip(`no account id for ${r.account}`); continue }
    if (!symbol) { skip(`symbol not in allow-list: ${r.symbol}`); continue }
    const q = Number(r.quantity)
    if (!(q > 0)) { skip('zero quantity'); continue }

    const key = `${accountId}|${r.txHash}|${symbol}`
    const signed = q * (r.direction === 'in' ? 1 : -1)
    const seen = perTx.get(key)
    if (seen) seen.net += signed
    else perTx.set(key, { row: r, symbol, accountId, net: signed })
  }

  for (const { row, symbol, accountId, net } of perTx.values()) {
    if (Math.abs(net) < 1e-12) continue // a round trip inside one transaction
    const unitPrice = priceFor(prices, symbol, row.date)
    if (unitPrice === undefined) { skip(`no price for ${symbol} on ${row.date}`); continue }
    out.push({
      accountId,
      date: `${row.date}T${row.time}Z`,
      activityType: net > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT',
      symbol,
      quantity: Math.abs(net),
      unitPrice,
      currency: 'USD',
    })
  }

  // 3. Merge same-day identical rows so none is silently skipped as a duplicate.
  const merged = new Map<string, PlanRow>()
  for (const r of out) {
    const key = [r.accountId, r.date.slice(0, 10), r.symbol, r.activityType, r.quantity.toFixed(10), r.unitPrice.toFixed(8)].join('|')
    const seen = merged.get(key)
    if (seen) seen.quantity += r.quantity
    else merged.set(key, { ...r })
  }

  return {
    rows: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)),
    skipped: [...skipped].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  }
}

/** Net signed quantity per `account|WF_SYMBOL`, for checking a plan against chain truth. */
export function planNet(rows: PlanRow[], accountNames: Record<string, string>): Map<string, number> {
  const net = new Map<string, number>()
  for (const r of rows) {
    const key = `${accountNames[r.accountId] ?? r.accountId}|${r.symbol}`
    net.set(key, (net.get(key) ?? 0) + r.quantity * (r.activityType === 'TRANSFER_IN' ? 1 : -1))
  }
  return net
}
