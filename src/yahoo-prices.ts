/**
 * Daily USD closes, from Yahoo.
 *
 * CoinGecko's free tier refuses any date older than 365 days, which makes it
 * useless for a history that starts in 2022. Yahoo serves the full series, and
 * it is the same provider Wealthfolio values these assets with — so a cost basis
 * built here agrees with the price Wealthfolio shows for the same day, rather
 * than disagreeing by a provider's worth of spread.
 *
 * One request returns every day for a symbol, so this is a handful of requests
 * for the whole import rather than one per movement.
 */

const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart'

/** Yahoo sends a browser check to unadorned clients. */
const HEADERS = { 'User-Agent': 'Mozilla/5.0' }

const day = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 10)

export type PriceTable = {
  /** `SYMBOL|YYYY-MM-DD` -> USD close. */
  prices: Record<string, number>
  /** Symbols Yahoo does not list, so no price could be had. */
  missing: string[]
}

/**
 * Daily closes for each symbol between `from` and `to` (inclusive ISO dates).
 *
 * Gaps in the series are filled forward from the last known close. Crypto trades
 * every day, so a gap is a reporting hole rather than a day without a price, and
 * carrying the previous close is far closer to the truth than refusing the row.
 */
export async function dailyPrices(
  symbols: string[],
  from: string,
  to: string,
): Promise<PriceTable> {
  const prices: Record<string, number> = {}
  const missing: string[] = []

  // A day either side, so the range's own endpoints are always covered.
  const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) - 86400
  const period2 = Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000) + 86400

  for (const symbol of symbols) {
    try {
      const res = await fetch(
        `${CHART}/${symbol}?period1=${period1}&period2=${period2}&interval=1d`,
        { headers: HEADERS },
      )
      if (!res.ok) {
        missing.push(symbol)
        continue
      }
      const body = (await res.json()) as any
      const result = body?.chart?.result?.[0]
      const stamps: number[] | undefined = result?.timestamp
      const closes: (number | null)[] | undefined = result?.indicators?.quote?.[0]?.close
      if (!stamps?.length || !closes?.length) {
        missing.push(symbol)
        continue
      }

      let last: number | undefined
      for (let i = 0; i < stamps.length; i++) {
        const close = closes[i]
        if (typeof close === 'number') last = close
        if (last !== undefined) prices[`${symbol}|${day(stamps[i]!)}`] = last
      }
      // A single fallback price, for a date outside the fetched range.
      if (last !== undefined) prices[symbol] = last
    } catch {
      missing.push(symbol)
    }
  }

  return { prices, missing }
}

/**
 * Fill weekend and holiday gaps forward across the whole date range, so a lookup
 * for any day between `from` and `to` resolves.
 */
export function fillForward(table: PriceTable, symbols: string[], from: string, to: string): void {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  for (const symbol of symbols) {
    let last: number | undefined
    for (let t = start; t <= end; t += 86400_000) {
      const d = new Date(t).toISOString().slice(0, 10)
      const key = `${symbol}|${d}`
      if (table.prices[key] !== undefined) last = table.prices[key]
      else if (last !== undefined) table.prices[key] = last
    }
  }
}
