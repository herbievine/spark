/**
 * Historical unit prices, per symbol and date.
 *
 * Cost basis is only as good as the price behind it, so these are fetched for
 * the actual date of each movement rather than reusing today's price. A price
 * that cannot be fetched is left absent, and the importer refuses that row —
 * guessing would silently corrupt basis in a way nothing later would reveal.
 */
import type { LedgerRow } from './ledger-export'

const COIN_IDS: Record<string, string> = {
  'ETH-USD': 'ethereum',
  'WETH-USD': 'weth',
  'EURC-USD': 'euro-coin',
  'XAUT-USD': 'tether-gold',
  'WBTC-USD': 'wrapped-bitcoin',
  'XPL-USD': 'plasma',
  'GHO-USD': 'gho',
}
const SYMBOL_OF: Record<string, string> = {
  ETH: 'ETH-USD', WETH: 'WETH-USD', EURC: 'EURC-USD', XAUT: 'XAUT-USD',
  WBTC: 'WBTC-USD', XPL: 'XPL-USD', GHO: 'GHO-USD',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Keyed `SYMBOL-USD` — a single price per symbol, from its earliest movement date. */
export async function historicalPrices(rows: LedgerRow[]): Promise<Map<string, number>> {
  const wanted = new Map<string, string>()
  for (const r of rows) {
    const sym = SYMBOL_OF[r.symbol]
    if (sym && !wanted.has(sym)) wanted.set(sym, r.date)
  }

  const out = new Map<string, number>()
  for (const [sym, date] of wanted) {
    const id = COIN_IDS[sym]
    if (!id) continue
    const [y, m, d] = date.split('-')
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/history?date=${d}-${m}-${y}&localization=false`)
      if (!res.ok) continue
      const body = (await res.json()) as any
      const usd = body?.market_data?.current_price?.usd
      if (typeof usd === 'number') out.set(sym, usd)
    } catch {
      // Absent price refuses the row downstream; that is the safe direction.
    }
    await sleep(2500) // free tier is strict
  }
  return out
}
