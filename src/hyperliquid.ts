/**
 * Hyperliquid — first-party Info API, keyless, and the same records behind the
 * CSV exports the account was originally built from.
 *
 * The venue keeps two wallets and Wealthfolio models it as one account, so the
 * relationship between them has to be exact. Measured against the API and
 * confirmed against Hyperliquid's own Balances and Positions tabs:
 *
 *   spot USDC total = available + hold
 *   hold            = open order notional + perp margin
 *
 * So `spotClearinghouseState` **already contains the perp margin**. Adding the
 * perp account value on top of the spot total double-counts it. Equity is built
 * from the parts that do not overlap.
 *
 * It is a Protocol because its value accrues with no transfer to observe, but it
 * also exposes `state()`: unlike a lending position it holds real assets that map
 * to Wealthfolio securities, so Job A needs the quantities too.
 */

import { Protocol, type ProtocolResult } from './protocol'

const INFO_URL = 'https://api.hyperliquid.xyz/info'

export type HyperliquidState = {
  /** Spot USDC as Hyperliquid reports it. This is what Wealthfolio tracks as cash. */
  spotUsdcTotal: number
  spotUsdcAvailable: number
  spotUsdcHold: number
  openBidNotional: number
  openOrderCount: number
  tokens: { coin: string; quantity: number; priceUsd: number | null; valueUsd: number }[]
  /** Collateral against open perps; includes unrealised PnL for isolated margin. */
  perpMargin: number
  unrealizedPnl: number
  openPerpPositions: number
  /** Total venue equity, with no component counted twice. */
  equityUsd: number
}

type SpotMeta = [
  { tokens: { index: number; name: string }[]; universe: { tokens: number[]; name: string }[] },
  { coin: string; midPx: string | null }[],
]

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Hyperliquid ${body.type} failed: ${res.status}`)
  return (await res.json()) as T
}

/**
 * Mid price in USDC per spot token index.
 *
 * Two traps, both of which yield prices that look plausible and are wrong by
 * orders of magnitude. `universe` and the context array are different lengths
 * (324 vs 715) so they cannot be zipped positionally — the context carries its own
 * `coin` name to join on. And token *names* are not unique: more than one listed
 * token is called HYPE, so the join must use the token index the balance reports.
 */
function midPricesByToken(meta: SpotMeta): Map<number, number> {
  const [spotMeta, contexts] = meta
  const contextByCoin = new Map(contexts.map((c) => [c.coin, c]))
  const prices = new Map<number, number>()

  for (const pair of spotMeta.universe) {
    const [base, quote] = pair.tokens
    if (quote !== 0 || base === undefined) continue // token 0 is USDC
    const midPx = contextByCoin.get(pair.name)?.midPx
    if (midPx) prices.set(base, Number(midPx))
  }
  return prices
}

export class Hyperliquid extends Protocol {
  readonly name = 'Hyperliquid'

  /** Full venue state, including the quantities Job A reconciles. */
  async state(address: string): Promise<HyperliquidState> {
    const [spotState, perpState, orders, meta] = await Promise.all([
      info<{ balances: { coin: string; token: number; total: string; hold: string }[] }>({
        type: 'spotClearinghouseState',
        user: address,
      }),
      info<{ assetPositions?: { position: { unrealizedPnl: string; marginUsed: string } }[] }>({
        type: 'clearinghouseState',
        user: address,
      }),
      info<{ side: string; limitPx: string; sz: string }[]>({ type: 'openOrders', user: address }),
      info<SpotMeta>({ type: 'spotMetaAndAssetCtxs' }),
    ])

    const prices = midPricesByToken(meta)
    const balances = spotState.balances ?? []

    const usdc = balances.find((b) => b.token === 0)
    const spotUsdcTotal = Number(usdc?.total ?? 0)
    const spotUsdcHold = Number(usdc?.hold ?? 0)

    const tokens = balances
      .filter((b) => b.token !== 0 && Number(b.total) > 0)
      .map((b) => {
        const priceUsd = prices.get(b.token) ?? null
        const quantity = Number(b.total)
        return { coin: b.coin, quantity, priceUsd, valueUsd: priceUsd === null ? 0 : quantity * priceUsd }
      })

    const openBidNotional = orders
      .filter((o) => o.side === 'B')
      .reduce((sum, o) => sum + Number(o.limitPx) * Number(o.sz), 0)

    const perps = perpState.assetPositions ?? []
    const perpMargin = perps.reduce((sum, p) => sum + Number(p.position.marginUsed), 0)
    const unrealizedPnl = perps.reduce((sum, p) => sum + Number(p.position.unrealizedPnl), 0)

    const spotUsdcAvailable = spotUsdcTotal - spotUsdcHold
    const tokenValue = tokens.reduce((sum, t) => sum + t.valueUsd, 0)

    return {
      spotUsdcTotal,
      spotUsdcAvailable,
      spotUsdcHold,
      openBidNotional,
      openOrderCount: orders.length,
      tokens,
      perpMargin,
      unrealizedPnl,
      openPerpPositions: perps.length,
      equityUsd: spotUsdcAvailable + openBidNotional + tokenValue + perpMargin,
    }
  }

  async positions(address: string): Promise<ProtocolResult> {
    try {
      const s = await this.state(address)
      const tokenValue = s.tokens.reduce((sum, t) => sum + t.valueUsd, 0)
      return {
        positions: [
          {
            protocol: this.name,
            chain: this.name,
            suppliedUsd: s.equityUsd,
            borrowedUsd: 0,
            netUsd: s.equityUsd,
          },
        ],
        errors: s.tokens.filter((t) => t.priceUsd === null).map((t) => `no USDC pair for ${t.coin}, valued at zero`),
        notes: [
          `equity ${s.equityUsd.toFixed(2)} = available ${s.spotUsdcAvailable.toFixed(2)} + bids ${s.openBidNotional.toFixed(2)} ` +
            `+ tokens ${tokenValue.toFixed(2)} + perp margin ${s.perpMargin.toFixed(2)}`,
        ],
      }
    } catch (err) {
      return { positions: [], errors: [`${this.name}: ${(err as Error).message}`], notes: [] }
    }
  }
}
