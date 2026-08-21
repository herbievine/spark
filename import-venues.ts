/**
 * Book the exchange records into their own Wealthfolio accounts.
 *
 * This does not double-count against the chain data, because the two describe
 * different accounts: a Coinbase "Send" is money leaving *Coinbase*, and the
 * transfer that arrives is money entering *a wallet*. Booking both is
 * double-entry, not duplication. `venues.ts` proves the two sides are the same
 * movement; this books each side where it belongs.
 *
 * Fiat rows (EUR) are skipped: these accounts track assets, and a euro balance
 * would need the cash side of every buy and sell to be modelled too.
 *
 * Dry run unless SPARK_COMMIT=1.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { Wealthfolio } from './src/wealthfolio'
import { dailyPrices, fillForward } from './src/yahoo-prices'

const COMMIT = process.env.SPARK_COMMIT === '1'

/** Verified against Wealthfolio's resolver: each resolves to CRYPTO, name checked. */
const SYMBOLS: Record<string, string> = {
  USDC: 'USDC-USD', ETH: 'ETH-USD', BTC: 'BTC-USD', DOT: 'DOT-USD', BUSD: 'BUSD-USD',
  USDT: 'USDT-USD', LINK: 'LINK-USD', AAVE: 'AAVE-USD', UNI: 'UNI-USD', SOL: 'SOL-USD',
  EURC: 'EURC-USD', ADA: 'ADA-USD', BNB: 'BNB-USD', ATOM: 'ATOM-USD', DOGE: 'DOGE-USD',
  XPL: 'XPL-USD', ALGO: 'ALGO-USD', AVAX: 'AVAX-USD', FDUSD: 'FDUSD-USD',
  CBETH: 'CBETH-USD', ETHW: 'ETHW-USD',
  POL: 'MATIC-USD', MATIC: 'MATIC-USD',
  // Coinbase's ETH2 is staked ETH, which it later converted back to ETH 1:1.
  ETH2: 'ETH-USD',
  // Deliberately absent: EUR (fiat, not an asset here) and ARB — 'ARB-USD'
  // resolves to "ARbit USD", which is not Arbitrum.
}

type Row = Record<string, string>
const rows: Row[] = (() => {
  const lines = readFileSync('ledger/venue-movements.csv', 'utf8').trim().split('\n')
  const parse = (line: string) => {
    const out: string[] = []
    let cur = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
      else if (c === ',' && !q) { out.push(cur); cur = '' }
      else cur += c
    }
    out.push(cur)
    return out
  }
  const header = parse(lines[0]!)
  return lines.slice(1).map((l) => {
    const cells = parse(l)
    const r: Row = {}
    header.forEach((h, i) => (r[h] = cells[i] ?? ''))
    return r
  })
})()

const wf = new Wealthfolio(process.env.SPARK_WF_URL!, process.env.SPARK_WF_TOKEN!)
await wf.connect()
const accounts = await wf.getAccounts()
const idOf = new Map(accounts.map((a) => [a.name, a.id]))

const skipped = new Map<string, number>()
const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1)

/**
 * What each venue operation actually is.
 *
 * Everything used to be booked by the sign of the quantity alone: positive was a
 * TRANSFER_IN, negative a TRANSFER_OUT. That made every Simple Earn interest
 * payment look like money arriving from outside the portfolio, which inflates
 * net contribution and suppresses the return that the interest *is* — and left
 * Wealthfolio reporting 3,245 transfers missing their other side, because most
 * of them never had one. Only 65 of Binance's 1,776 rows were ever transfers.
 *
 * `trade` books BUY when the quantity is positive and SELL when negative, which
 * is what makes a convert two legs of one swap rather than two mystery
 * transfers. `fiat` is a purchase or sale against currency the portfolio does
 * not hold: booked as a transfer because the money genuinely crosses the
 * boundary. Booking those as BUY instead drove Coinbase's cash to -1,980, since
 * a BUY spends cash that a euro bank account — invisible here — actually paid. `income` is INTEREST carrying its asset — see `STAKING_REWARD`
 * below. `internal` moves between two wallets of the same venue, which are one
 * account here, so both legs would cancel and neither is booked.
 */
type Kind = 'transfer' | 'trade' | 'fiat' | 'income' | 'internal'

const BINANCE_OPS: Record<string, Kind> = {
  'Simple Earn Flexible - Rewards Income': 'income',
  'Simple Earn Flexible Interest': 'income',
  'Airdrop Assets': 'income',
  // Spot <-> earn wallet; both are the one Binance account.
  'Simple Earn Flexible Subscription': 'internal',
  'Simple Earn Flexible Redemption': 'internal',
  'Auto-Invest Transaction': 'trade',
  'Binance Convert': 'trade',
  'Small Assets Exchange BNB': 'trade',
  'Stablecoins Auto-Conversion': 'trade',
  // Against euros, which this portfolio does not track: the value crosses in
  // and out rather than moving between two things it already holds.
  'Buy Crypto With Fiat': 'fiat',
  'Sell to Card': 'fiat',
  'Transaction Buy': 'fiat',
  'Transaction Revenue': 'fiat',
  'Transaction Sold': 'fiat',
  'Transaction Spend': 'fiat',
  // Paid in an asset, so it is a disposal of that asset, not a cash fee: a
  // cash FEE row would leave the coins that paid it sitting in the balance.
  'Transaction Fee': 'trade',
  Deposit: 'transfer',
  Withdraw: 'transfer',
}

const COINBASE_OPS: Record<string, Kind> = {
  Send: 'transfer',
  Receive: 'transfer',
  Deposit: 'transfer',
  Withdrawal: 'transfer',
  // Bought with and sold for euros — see `fiat` above.
  Buy: 'fiat',
  Sell: 'fiat',
  Convert: 'trade',
  'Wrap Asset': 'trade',
  'Retail Simple Dust': 'trade',
  'Staking Income': 'income',
  'Reward Income': 'income',
  'Incentives Rewards Payout': 'income',
  // Staking and the ETH2 migration move between Coinbase's own wallets.
  'Retail Staking Transfer': 'internal',
  'Retail Unstaking Transfer': 'internal',
  'Retail Eth2 Deprecation': 'internal',
  Subscription: 'trade',
}

const kindOf = (venue: string, op: string): Kind | undefined =>
  venue === 'Binance' ? BINANCE_OPS[op] : venue === 'Coinbase' ? COINBASE_OPS[op] : undefined

type Planned = {
  accountId: string
  date: string
  activityType: string
  symbol: string
  quantity: number
  unitPrice: number
  currency: string
  subtype?: string
  amount?: number
}
const wanted: { row: Row; accountId: string; symbol: string; qty: number; kind: Kind }[] = []

/**
 * What the skipped internal moves leave behind.
 *
 * Dropping both legs of a spot<->earn move is only safe when they cancel, and
 * here they do not: the exports begin part-way through, so funds already sitting
 * in Simple Earn are redeemed inside the window without the matching
 * subscription ever appearing. Binance nets +299.49 BUSD that way. Drop both
 * legs and the later disposals have nothing to sell — BUSD would settle at
 * -299.49 and Wealthfolio would clamp it at zero, permanently.
 *
 * So the churn is dropped but its residue is not: one row per asset restores
 * exactly what the balance was before the export starts. It is genuinely an
 * opening position, and genuinely external to this history.
 */
const internalNet = new Map<string, { accountId: string; symbol: string; net: number; first: string }>()
const day = (r: Row) => r.date ?? ''

for (const r of rows) {
  // peer.xyz is an on-ramp, not an account Herbie holds a balance in: its
  // fulfilled orders arrive in a wallet, and the chain capture already books
  // them there. Booking them again here would genuinely double-count.
  if (r.venue === 'peer.xyz') { skip('peer.xyz — already booked via the wallet it arrived in'); continue }
  const accountId = idOf.get(r.venue!)
  if (!accountId) { skip(`no Wealthfolio account for ${r.venue}`); continue }
  const symbol = SYMBOLS[(r.asset ?? '').toUpperCase()]
  if (!symbol) { skip(`asset not mapped: ${r.asset}`); continue }
  const qty = Number(r.quantity)
  if (!Number.isFinite(qty) || qty === 0) { skip('zero quantity'); continue }

  // An operation with no mapping is refused rather than guessed at from its
  // sign — guessing is exactly what produced the mis-typed history this
  // replaces. A new Binance operation shows up here as a named skip.
  const kind = kindOf(r.venue!, r.kind ?? '')
  if (!kind) { skip(`unmapped ${r.venue} operation: ${r.kind}`); continue }
  if (kind === 'internal') {
    skip(`${r.venue} internal move (both wallets are one account): ${r.kind}`)
    const key = `${accountId}|${symbol}`
    const seen = internalNet.get(key)
    if (seen) { seen.net += qty; if (day(r) < seen.first) seen.first = day(r) }
    else internalNet.set(key, { accountId, symbol, net: qty, first: day(r) })
    continue
  }

  wanted.push({ row: r, accountId, symbol, qty, kind })
}

const residuals = [...internalNet.values()].filter((r) => Math.abs(r.net) > 1e-9)
const days = [...wanted.map((w) => w.row.date!), ...residuals.map((r) => r.first)].sort()
const symbols = [...new Set([...wanted.map((w) => w.symbol), ...residuals.map((r) => r.symbol)])]
const from = days[0] ?? '2022-01-01'
const to = new Date().toISOString().slice(0, 10)
const table = await dailyPrices(symbols, from, to)
fillForward(table, symbols, from, to)

const plan: Planned[] = []
for (const w of wanted) {
  const day = w.row.date!
  const price = table.prices[`${w.symbol}|${day}`] ?? table.prices[w.symbol]
  if (price === undefined) { skip(`no price for ${w.symbol}`); continue }
  const quantity = Math.abs(w.qty)
  // Real instants: a bare date puts every row on a day at the same moment and
  // Wealthfolio cannot then order a disposal after its acquisition.
  const date = `${day}T${w.row.time || '12:00:00'}Z`
  const base = { accountId: w.accountId, date, symbol: w.symbol, quantity, unitPrice: price, currency: 'USD' }

  if (w.kind === 'income') {
    /**
     * Income paid in the asset itself, not in cash.
     *
     * Plain INTEREST is a cash row — quantity 1, amount in currency — so using
     * it here would credit the return but never deliver the coins, and the
     * Binance holdings would fall by every reward ever paid. The STAKING_REWARD
     * subtype is the asset-denominated form: it carries symbol, quantity and
     * unit price, so the position grows *and* the growth counts as return
     * rather than as money the portfolio was given from outside.
     */
    plan.push({ ...base, activityType: 'INTEREST', subtype: 'STAKING_REWARD', amount: quantity * price })
  } else if (w.kind === 'trade') {
    plan.push({ ...base, activityType: w.qty > 0 ? 'BUY' : 'SELL' })
  } else {
    // 'transfer' and 'fiat' alike: value entering or leaving the portfolio.
    plan.push({ ...base, activityType: w.qty > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT' })
  }
}

// The opening positions the skipped internal churn would otherwise have removed.
// Dated a day before the first move they replace, so nothing they fund is ever
// disposed of before it exists.
for (const r of residuals) {
  const price = table.prices[`${r.symbol}|${r.first}`] ?? table.prices[r.symbol]
  if (price === undefined) { skip(`no price for residual ${r.symbol}`); continue }
  const opening = new Date(Date.parse(`${r.first}T12:00:00Z`) - 86400_000).toISOString().replace('.000', '')
  plan.push({
    accountId: r.accountId,
    date: opening,
    activityType: r.net > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT',
    symbol: r.symbol,
    quantity: Math.abs(r.net),
    unitPrice: price,
    currency: 'USD',
  })
}

/**
 * Break ties between an acquisition and a disposal at the same instant.
 *
 * A convert reports both legs on the same second, and with equal timestamps the
 * order is whatever the sort happens to pick. Pick the disposal first and the
 * balance dips below zero on the way — Binance USDT fell to -65.11 that way, on
 * a pair that nets to +0.002. Wealthfolio clamps such a dip and never recovers
 * it, so the disposal is moved one second later: sub-second ordering carries no
 * meaning here, but funding a sale before making it does.
 */
{
  const ADDS = new Set(['TRANSFER_IN', 'BUY', 'INTEREST'])
  const groups = new Map<string, Planned[]>()
  for (const p of plan) {
    const key = `${p.accountId}|${p.symbol}|${p.date}`
    const g = groups.get(key)
    if (g) g.push(p)
    else groups.set(key, [p])
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    if (!group.some((p) => ADDS.has(p.activityType))) continue
    for (const p of group) {
      if (!ADDS.has(p.activityType)) p.date = new Date(Date.parse(p.date) + 1000).toISOString().replace('.000', '')
    }
  }
}

/**
 * Merge identical rows falling on the same day.
 *
 * Wealthfolio fingerprints duplicates on the calendar day, so twenty identical
 * Simple Earn interest payments on one day are read as one row repeated and
 * nineteen are silently skipped — which is exactly what happened: 1,094 of 3,601
 * vanished on the first pass. Summing them keeps the quantity truthful and
 * presents Wealthfolio with one row it will actually accept.
 */
const mergedPlan = (() => {
  const merged = new Map<string, Planned & { merged: number }>()
  for (const p of plan) {
    // Subtype is part of the key: an INTEREST/STAKING_REWARD row and a plain
    // cash row are different kinds of event and must never collapse together.
    const key = [p.accountId, p.date.slice(0, 10), p.symbol, p.activityType, p.subtype ?? ''].join('|')
    const seen = merged.get(key)
    if (seen) {
      // Weight the price by quantity, so the merged row's value is the sum of
      // the values rather than an arbitrary one of the prices.
      const total = seen.quantity + p.quantity
      seen.unitPrice = (seen.unitPrice * seen.quantity + p.unitPrice * p.quantity) / total
      seen.quantity = total
      if (seen.amount !== undefined) seen.amount = seen.quantity * seen.unitPrice
      seen.merged++
    } else merged.set(key, { ...p, merged: 1 })
  }
  return [...merged.values()]
})()

const collapsed = plan.length - mergedPlan.length
plan.length = 0
plan.push(...mergedPlan.map(({ merged, ...rest }) => rest))

/**
 * Put every merged day's acquisitions before its disposals.
 *
 * Merging keeps one row per day and inherits the *first* timestamp in the
 * group, which silently reorders the day: Coinbase received 3,000.002151 USDC
 * at 16:56 and sent the same amount away at 16:57, but that send merged with an
 * earlier 22.76 one from 13:00 and inherited 13:00 — so the day's outflow now
 * came three hours before the inflow that funded it, and the balance dipped to
 * -3,000 on a day that actually nets to zero. Wealthfolio clamped it, which is
 * why Coinbase reads 729.66 today.
 *
 * The exact time inside a merged day means nothing once the rows are summed, so
 * it is chosen rather than inherited: acquisitions at the open, disposals at the
 * close. Nothing is ever sold on a day before the day's purchases exist.
 */
for (const p of plan) {
  const isAdd = p.activityType === 'TRANSFER_IN' || p.activityType === 'BUY' || p.activityType === 'INTEREST'
  p.date = `${p.date.slice(0, 10)}T${isAdd ? '00:00:00' : '23:59:59'}Z`
}

/**
 * Book the position each account already held when its export begins.
 *
 * These exports do not reach back to the first trade, so an asset is routinely
 * sold here that was bought before the window. Left alone the running balance
 * goes negative, and Wealthfolio clamps a disposal at zero rather than going
 * below it — the shortfall then sticks forever. That is not hypothetical: the
 * Binance USDC balance reads 208.07 today against an export netting 7.94, and
 * the 200.13 difference is precisely the clamp.
 *
 * So the same number is booked deliberately instead of arrived at by accident:
 * the smallest opening that keeps the balance non-negative throughout. Holdings
 * come out where they are now, but derived from a row that can be inspected
 * rather than from an arithmetic failure.
 */
const openings: { accountId: string; symbol: string; quantity: number }[] = []
{
  const ADDS = new Set(['TRANSFER_IN', 'BUY', 'INTEREST'])
  const firstDate = plan.map((p) => p.date).sort()[0] ?? '2022-01-01T00:00:00Z'
  const opensAt = new Date(Date.parse(firstDate) - 86400_000).toISOString().replace('.000', '')

  for (const key of new Set(plan.map((p) => `${p.accountId}|${p.symbol}`))) {
    const [accountId, symbol] = key.split('|') as [string, string]
    const series = plan
      .filter((p) => p.accountId === accountId && p.symbol === symbol)
      .sort((a, b) => a.date.localeCompare(b.date))
    let balance = 0
    let worst = 0
    for (const p of series) {
      balance += ADDS.has(p.activityType) ? p.quantity : -p.quantity
      if (balance < worst) worst = balance
    }
    if (worst >= -1e-9) continue
    const quantity = -worst
    const price = table.prices[`${symbol}|${opensAt.slice(0, 10)}`] ?? table.prices[symbol]
    if (price === undefined) { skip(`no price for opening ${symbol}`); continue }
    openings.push({ accountId, symbol, quantity })
    plan.push({ accountId, date: opensAt, activityType: 'TRANSFER_IN', symbol, quantity, unitPrice: price, currency: 'USD' })
  }
}

writeFileSync('.local/venue-plan.json', JSON.stringify(plan, null, 1))
console.log(`venue activities planned: ${plan.length}  -> .local/venue-plan.json`)
console.log(`same-day rows merged:     ${collapsed} (would have been skipped as duplicates)`)
console.log(`prices missing: ${table.missing.length ? table.missing.join(', ') : 'none'}`)
console.log('\nskipped:')
for (const [why, n] of [...skipped].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${why}`)

const byType = new Map<string, number>()
for (const p of plan) {
  const label = p.subtype ? `${p.activityType}/${p.subtype}` : p.activityType
  byType.set(label, (byType.get(label) ?? 0) + 1)
}
if (openings.length) {
  console.log('\nopening positions booked (pre-export holdings, previously supplied by clamping):')
  for (const o of openings) console.log(`  ${o.symbol.padEnd(10)} ${o.quantity}`)
}

console.log('\nby activity type:')
for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${t}`)

const byAccount = new Map<string, number>()
for (const p of plan) byAccount.set(p.accountId, (byAccount.get(p.accountId) ?? 0) + 1)
console.log('\nby account:')
for (const [id, n] of byAccount) console.log(`  ${accounts.find((a) => a.id === id)?.name ?? id}: ${n}`)

if (!COMMIT) {
  console.log('\nDRY RUN — set SPARK_COMMIT=1 to import')
  process.exit(0)
}

let imported = 0
for (let i = 0; i < plan.length; i += 100) {
  const slice = plan.slice(i, i + 100).map((r, n) => ({ ...r, lineNumber: i + n + 1 }))
  const check = await wf.tool<any>('prepare_activity_import', { activities: slice })
  const ok = (check.rows ?? []).map((r: any) => r.isValid !== false && r.isDuplicate !== true)
  const toCommit = slice.filter((_, n) => ok[n])
  if (toCommit.length) {
    await wf.tool('commit_activity_import', { activities: toCommit })
    imported += toCommit.length
  }
  console.log(`batch ${i / 100 + 1}: committed ${toCommit.length}/${slice.length}`)
}
console.log(`\nIMPORTED ${imported}`)
