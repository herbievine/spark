/**
 * The two reports. Both are read-only: they compare and print, and write nothing.
 *
 * Job A (`buildReport`) reconciles *quantities* against Wealthfolio's holdings.
 * Job B (`buildDefiReport`) values *positions* that accrue with no transfer to
 * observe. They are kept apart deliberately — different questions, different
 * cadences, different sources.
 */

import { loadAddressBook, type AddressBookIssue } from './address-book'
import { AaveV3 } from './aave'
import { Hyperliquid } from './hyperliquid'
import { Wallet } from './wallet'
import { Protocol, type Position } from './protocol'
import { Wealthfolio } from './wealthfolio'
import { CASH_EPSILON, DUST_TOLERANCE_USD, HL_CASH_COINS, HL_SYMBOLS, QUANTITY_EPSILON } from './config'
import { fetchUsdPrices, priceKey } from './prices'
import { SparkState } from './state'

export type DriftRow = {
  account: string
  symbol: string
  chain: number | null
  wealthfolio: number | null
  drift: number | null
  status: 'ok' | 'drift' | 'missing-in-wealthfolio' | 'missing-on-chain'
}

export type DriftReport = {
  generatedAt: string
  rows: DriftRow[]
  /** Anything that stopped a comparison being made. Never silently dropped. */
  alerts: string[]
  /** Informational breakdowns; never a reason to fail a run. */
  notes: string[]
  issues: AddressBookIssue[]
}

function classify(chain: number | null, wf: number | null, epsilon: number): DriftRow['status'] {
  if (chain === null) return 'missing-on-chain'
  if (wf === null) return 'missing-in-wealthfolio'
  return Math.abs(chain - wf) <= epsilon ? 'ok' : 'drift'
}

function row(
  account: string,
  symbol: string,
  chain: number | null,
  wf: number | null,
  epsilon = QUANTITY_EPSILON,
): DriftRow {
  return {
    account,
    symbol,
    chain,
    wealthfolio: wf,
    drift: chain !== null && wf !== null ? chain - wf : null,
    status: classify(chain, wf, epsilon),
  }
}

export async function buildReport(opts: {
  dbPath: string
  baseUrl: string
  token: string
  /** Spark's state, used purely as a price cache. Optional so tests need none. */
  statePath?: string
}): Promise<DriftReport> {
  const { accounts, issues } = loadAddressBook(opts.dbPath)
  const alerts: string[] = []
  const notes: string[] = []
  const rows: DriftRow[] = []

  const wf = new Wealthfolio(opts.baseUrl, opts.token)
  await wf.connect()
  const hyperliquid = new Hyperliquid()
  // Prices are cached because CoinGecko's free tier rate-limits within minutes;
  // without this every holding reads as "price unknown" and no row is filtered.
  const priceCache = opts.statePath ? new SparkState(opts.statePath) : undefined

  for (const account of accounts) {
    let holdings
    try {
      holdings = await wf.getHoldings(account.accountId)
    } catch (err) {
      alerts.push(`${account.name}: could not read Wealthfolio holdings — ${err}`)
      continue
    }

    const wfQuantities = new Map<string, number>()
    for (const h of holdings) {
      if (h.holdingType === 'Security') wfQuantities.set(h.symbol, h.quantity)
    }

    if (account.venue === 'hyperliquid') {
      const state = await hyperliquid.state(account.address)

      for (const balance of state.tokens) {
        if (HL_CASH_COINS.has(balance.coin)) continue
        const symbol = HL_SYMBOLS[balance.coin]
        if (!symbol) {
          // An unmapped coin must alert rather than skip — a silent skip is a
          // balance that quietly stops matching.
          alerts.push(`${account.name}: no symbol mapping for Hyperliquid coin ${balance.coin}`)
          continue
        }
        rows.push(row(account.name, symbol, balance.quantity, wfQuantities.get(symbol) ?? null))
        wfQuantities.delete(symbol)
      }

      // Spot USDC total already includes the perp margin, and Wealthfolio books
      // perps as cash. Adding the perp account value would double-count it.
      let wfCash: number | null = null
      try {
        wfCash = await wf.getCash(account.accountId)
      } catch (err) {
        alerts.push(`${account.name}: could not read cash balance — ${err}`)
      }
      rows.push(row(account.name, 'USDC (cash)', state.spotUsdcTotal, wfCash, CASH_EPSILON))

      notes.push(
        `${account.name}: spot USDC ${state.spotUsdcTotal.toFixed(2)} = available ${state.spotUsdcAvailable.toFixed(2)} ` +
          `+ ${state.openOrderCount} open orders ${state.openBidNotional.toFixed(2)} + perp margin ${state.perpMargin.toFixed(2)}`,
      )
      if (state.openPerpPositions > 0) {
        // import-hyperliquid.ts books this as one row it rewrites each sync, so
        // the residual drift is only however far the mark has moved since — a
        // note rather than an alert, and not something to chase.
        notes.push(
          `${account.name}: ${state.openPerpPositions} open perp position(s) carrying ` +
            `${state.unrealizedPnl.toFixed(2)} unrealised PnL. Booked as a single row refreshed on each ` +
            `sync, so cash drifts only by what the mark has moved since the last one`,
        )
      }
    } else {
      // A Safe holds tokens like any other address, so the same reader serves
      // both; the Safe Transaction Service is only needed for the Phase 2
      // transaction feed.
      const wallet = new Wallet(account.address as `0x${string}`)
      const { balances, errors } = await wallet.balances()
      for (const e of errors) alerts.push(`${account.name}: ${e}`)

      // Wealthfolio holds one quantity per symbol per account, but the same asset
      // can sit on several chains. Compare the *sum* across chains against that
      // single holding — matching per chain would let the first chain claim the
      // whole holding and report every other chain as missing.
      // Prices are fetched only to decide what is worth showing. They never enter
      // the drift calculation, which is done on quantities.
      const prices = await fetchUsdPrices(balances, priceCache)

      type Group = { total: number; chains: string[]; usd: number | null; spam: boolean }
      const bySymbol = new Map<string, Group>()
      for (const balance of balances) {
        const entry = bySymbol.get(balance.symbol) ?? { total: 0, chains: [], usd: null, spam: true }
        entry.total += balance.quantity
        entry.chains.push(`${balance.chain} ${balance.quantity}`)
        entry.spam &&= balance.dust
        const price = prices.get(priceKey(balance.chainId, balance.contract))
        if (price !== undefined) entry.usd = (entry.usd ?? 0) + balance.quantity * price
        bySymbol.set(balance.symbol, entry)
      }

      const hidden: string[] = []
      for (const [symbol, group] of bySymbol) {
        const held = wfQuantities.get(symbol) ?? null

        // Never hide something Wealthfolio holds: that is precisely where a real
        // discrepancy would show up. Only unheld, provably-small positions are
        // suppressed — an unknown price is not "small".
        const negligible = group.spam || (group.usd !== null && group.usd < DUST_TOLERANCE_USD)
        if (held === null && negligible) {
          hidden.push(group.usd === null ? `${symbol} (spam)` : `${symbol} ($${group.usd.toFixed(2)})`)
          wfQuantities.delete(symbol)
          continue
        }

        rows.push(row(account.name, symbol, group.total, held))
        wfQuantities.delete(symbol)
        if (group.chains.length > 1) notes.push(`${account.name} ${symbol}: ${group.chains.join(' + ')}`)
      }

      if (hidden.length) {
        notes.push(
          `${account.name}: ${hidden.length} holding(s) below the $${DUST_TOLERANCE_USD} threshold, hidden — ${hidden.join(', ')}`,
        )
      }
    }

    // Anything Wealthfolio holds that the chain did not account for.
    for (const [symbol, quantity] of wfQuantities) {
      rows.push(row(account.name, symbol, null, quantity))
    }
  }

  priceCache?.close()
  return { generatedAt: new Date().toISOString(), rows, alerts, notes, issues }
}

export type DefiReport = {
  generatedAt: string
  positions: Position[]
  byAccount: { account: string; positions: Position[]; totalUsd: number }[]
  totalUsd: number
  alerts: string[]
  notes: string[]
  issues: AddressBookIssue[]
}

/**
 * Job B. Every protocol is asked about every address it could apply to; the
 * protocol decides whether it holds anything.
 */
export async function buildDefiReport(opts: { dbPath: string }): Promise<DefiReport> {
  const { accounts, issues } = loadAddressBook(opts.dbPath)
  const alerts: string[] = []
  const notes: string[] = []
  const byAccount: DefiReport['byAccount'] = []

  const onChain: Protocol[] = [new AaveV3()]
  const hyperliquid = new Hyperliquid()

  for (const account of accounts) {
    // Hyperliquid is a venue keyed by an address rather than a chain deployment,
    // so it answers for its own account only.
    const protocols = account.venue === 'hyperliquid' ? [hyperliquid] : onChain

    const positions: Position[] = []
    for (const protocol of protocols) {
      const result = await protocol.positions(account.address)
      // Protocols price their own positions, so the threshold applies directly.
      const [shown, small] = [
        result.positions.filter((p) => Math.abs(p.netUsd) >= DUST_TOLERANCE_USD),
        result.positions.filter((p) => Math.abs(p.netUsd) < DUST_TOLERANCE_USD),
      ]
      if (small.length) {
        notes.push(
          `${account.name}: ${small.length} ${protocol.name} position(s) below $${DUST_TOLERANCE_USD}, hidden — ` +
            small.map((p) => `${p.chain} $${p.netUsd.toFixed(2)}`).join(', '),
        )
      }
      positions.push(...shown)
      for (const e of result.errors) alerts.push(`${account.name}: ${e}`)
      for (const n of result.notes) notes.push(`${account.name}: ${n}`)
    }

    if (positions.length) {
      byAccount.push({
        account: account.name,
        positions,
        totalUsd: positions.reduce((sum, p) => sum + p.netUsd, 0),
      })
    }
  }

  const positions = byAccount.flatMap((a) => a.positions)
  return {
    generatedAt: new Date().toISOString(),
    positions,
    byAccount,
    totalUsd: positions.reduce((sum, p) => sum + p.netUsd, 0),
    alerts,
    notes,
    issues,
  }
}

function pad(rows: string[][], align: ('l' | 'r')[]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)))
  return rows.map((r) =>
    r.map((cell, i) => (align[i] === 'r' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join('  '),
  )
}

function tail(out: string[], report: { notes: string[]; alerts: string[]; issues: AddressBookIssue[] }): string {
  if (report.issues.length) {
    out.push('', 'ADDRESS BOOK')
    for (const i of report.issues) out.push(`  ! ${i.account}: ${i.problem}`)
  }
  if (report.notes.length) {
    out.push('', 'NOTES')
    for (const n of report.notes) out.push(`  - ${n}`)
  }
  if (report.alerts.length) {
    out.push('', 'ALERTS')
    for (const a of report.alerts) out.push(`  ! ${a}`)
  }
  return out.join('\n')
}

export function renderText(report: DriftReport): string {
  const num = (n: number | null) => (n === null ? '—' : n.toFixed(8))
  const table = pad(
    [
      ['ACCOUNT', 'SYMBOL', 'CHAIN', 'WEALTHFOLIO', 'DRIFT', 'STATUS'],
      ...report.rows.map((r) => [
        r.account,
        r.symbol,
        num(r.chain),
        num(r.wealthfolio),
        num(r.drift),
        r.status,
      ]),
    ],
    ['l', 'l', 'r', 'r', 'r', 'l'],
  )

  const out = [`Spark drift report — ${report.generatedAt}`, '', ...table]
  if (!report.rows.some((r) => r.status !== 'ok') && !report.alerts.length) out.push('', 'Everything reconciles.')
  return tail(out, report)
}

export function renderDefiText(report: DefiReport): string {
  const out = [`Spark DeFi positions — ${report.generatedAt}`, '']
  if (!report.positions.length) {
    out.push('No positions found above the dust threshold.')
  } else {
    const table = pad(
      [
        ['ACCOUNT', 'PROTOCOL', 'CHAIN', 'SUPPLIED', 'BORROWED', 'NET USD'],
        ...report.byAccount.flatMap((a) =>
          a.positions.map((p) => [
            a.account,
            p.protocol,
            p.chain,
            p.suppliedUsd.toFixed(4),
            p.borrowedUsd.toFixed(4),
            p.netUsd.toFixed(4),
          ]),
        ),
      ],
      ['l', 'l', 'l', 'r', 'r', 'r'],
    )
    out.push(...table, '', `Total: $${report.totalUsd.toFixed(4)}`)
  }
  return tail(out, report)
}
