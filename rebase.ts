/**
 * Rebase a Wealthfolio crypto account onto derived balances.
 *
 * Opening positions are booked on 2026-01-01, then every 2026 movement is
 * replayed on top, so the balance Wealthfolio shows is *derived from movements*
 * rather than asserted. That is what makes a performance curve meaningful: an
 * asserted balance has no history behind it.
 *
 * Opening quantity = today's on-chain balance minus the net 2026 movement. A
 * negative result means an outflow was never captured; those are clamped to zero
 * and reported, because inventing a negative position would be worse than
 * understating one.
 *
 * `TRANSFER_IN` opens the position without touching cash, at the price on the
 * day. Unrealised gain therefore starts at zero — truthful, since the real
 * pre-2026 basis is not known here, and everything from 2026-01-01 forward
 * tracks exactly. Pre-2026 history can be layered underneath later.
 */

import { readFileSync } from 'node:fs'

export const OPENING_DATE = '2026-01-01'

/** USD prices on OPENING_DATE, from CoinGecko's historical endpoint. */
export const OPENING_PRICES: Record<string, number> = {
  ETH: 2970.028682356399,
  WETH: 2969.578634404794,
  USDC: 0.9993491227282315,
  XAUT: 4318.183175066801,
  EURC: 1.1737022179937668,
  XPL: 0.16212873884616216,
}

export type Row = Record<string, string>

export function readLedger(path: string): Row[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const header = lines[0]!.split(',')
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    const row: Row = {}
    header.forEach((h, i) => (row[h] = cells[i] ?? ''))
    return row
  })
}

/** Net signed movement per account+symbol, excluding anything marked doNotBook. */
export function netMovements(rows: Row[], allowed: Record<string, string>): Map<string, number> {
  const net = new Map<string, number>()
  for (const r of rows) {
    if (r.doNotBook) continue
    if (!allowed[r.symbol!]) continue
    const key = `${r.account}|${r.symbol}`
    const q = Number(r.quantity) * (r.direction === 'in' ? 1 : -1)
    net.set(key, (net.get(key) ?? 0) + q)
  }
  return net
}
