/**
 * USD prices — for **display filtering only**.
 *
 * Spark reconciles quantities, never values, so a price never participates in
 * deciding whether something has drifted. It decides only whether a row is worth
 * showing. That distinction matters: Wealthfolio has its own market data, and if
 * pricing fed into the comparison Spark would report drift its own price source
 * invented. A wrong price here can hide a row; it can never fabricate one.
 *
 * CoinGecko's keyless endpoint is used because it needs no account and no
 * credential. When it is unavailable, prices are simply unknown and the report
 * falls back to showing everything not explicitly registered as spam — failing
 * towards visibility rather than towards silence.
 */

const BASE = 'https://api.coingecko.com/api/v3'

/** chainId -> CoinGecko asset platform id. Chains absent here get no token prices. */
const PLATFORMS: Record<number, string> = {
  1: 'ethereum',
  42161: 'arbitrum-one',
  100: 'xdai',
  137: 'polygon-pos',
  8453: 'base',
  10: 'optimistic-ethereum',
  56: 'binance-smart-chain',
  43114: 'avalanche',
}

/** chainId -> CoinGecko coin id for the chain's native token. */
const NATIVE_IDS: Record<number, string> = {
  1: 'ethereum',
  42161: 'ethereum',
  100: 'xdai',
  137: 'polygon-ecosystem-token',
  8453: 'ethereum',
  10: 'ethereum',
  56: 'binancecoin',
  43114: 'avalanche-2',
  9745: 'plasma',
  143: 'monad',
}

export type PriceKey = string
/** Stable key for a priced thing: chainId + contract, or chainId + "native". */
export const priceKey = (chainId: number, contract: string | null): PriceKey =>
  `${chainId}:${(contract ?? 'native').toLowerCase()}`

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Best-effort USD prices for the given holdings. Missing entries mean "unknown",
 * which callers must treat as "show it", not "worthless".
 */
export const PRICE_TTL_SECONDS = 6 * 60 * 60

/**
 * Optional persistent cache. Without it Spark trips CoinGecko's free rate limit
 * (verified: 429 within minutes), and every holding then reads as "price
 * unknown" — which is safe but shows every dust row.
 */
export type PriceCache = {
  cachedPrices(maxAgeSeconds: number): Map<string, number>
  allPrices(): Map<string, number>
  putPrices(prices: Map<string, number>): void
}

export async function fetchUsdPrices(
  holdings: { chainId: number; contract: string | null }[],
  cache?: PriceCache,
): Promise<Map<PriceKey, number>> {
  const prices = new Map<PriceKey, number>()

  if (cache) {
    const fresh = cache.cachedPrices(PRICE_TTL_SECONDS)
    const needed = holdings.filter((h) => !fresh.has(priceKey(h.chainId, h.contract)))
    for (const [k, v] of fresh) prices.set(k, v)
    // Everything already fresh: make no request at all.
    if (!needed.length) return prices
    holdings = needed
  }

  // Native tokens: one call for every distinct coin id.
  const nativeChains = [...new Set(holdings.filter((h) => !h.contract).map((h) => h.chainId))]
  const nativeIds = [...new Set(nativeChains.map((id) => NATIVE_IDS[id]).filter(Boolean))]
  if (nativeIds.length) {
    const data = await getJson(`${BASE}/simple/price?ids=${nativeIds.join(',')}&vs_currencies=usd`)
    if (data) {
      for (const chainId of nativeChains) {
        const usd = data[NATIVE_IDS[chainId] ?? '']?.usd
        if (typeof usd === 'number') prices.set(priceKey(chainId, null), usd)
      }
    }
  }

  // Tokens: one call per platform, batching every contract on that chain.
  const byChain = new Map<number, string[]>()
  for (const h of holdings) {
    if (!h.contract) continue
    byChain.set(h.chainId, [...(byChain.get(h.chainId) ?? []), h.contract.toLowerCase()])
  }

  for (const [chainId, contracts] of byChain) {
    const platform = PLATFORMS[chainId]
    if (!platform) continue
    const data = await getJson(
      `${BASE}/simple/token_price/${platform}?contract_addresses=${[...new Set(contracts)].join(',')}&vs_currencies=usd`,
    )
    if (!data) continue
    for (const [contract, value] of Object.entries<any>(data)) {
      if (typeof value?.usd === 'number') prices.set(priceKey(chainId, contract), value.usd)
    }
  }

  if (cache) {
    cache.putPrices(prices)
    // Fall back to any older cached price for what could not be refreshed —
    // a stale price still answers "is this worth more than $5?".
    for (const [k, v] of cache.allPrices()) if (!prices.has(k)) prices.set(k, v)
  }

  return prices
}
