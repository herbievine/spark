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

type Planned = { accountId: string; date: string; activityType: string; symbol: string; quantity: number; unitPrice: number; currency: string }
const wanted: { row: Row; accountId: string; symbol: string; qty: number }[] = []

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
  wanted.push({ row: r, accountId, symbol, qty })
}

const days = wanted.map((w) => w.row.date!).sort()
const symbols = [...new Set(wanted.map((w) => w.symbol))]
const from = days[0] ?? '2022-01-01'
const to = new Date().toISOString().slice(0, 10)
const table = await dailyPrices(symbols, from, to)
fillForward(table, symbols, from, to)

const plan: Planned[] = []
for (const w of wanted) {
  const day = w.row.date!
  const price = table.prices[`${w.symbol}|${day}`] ?? table.prices[w.symbol]
  if (price === undefined) { skip(`no price for ${w.symbol}`); continue }
  plan.push({
    accountId: w.accountId,
    // Real instants: a bare date puts every row on a day at the same moment and
    // Wealthfolio cannot then order a disposal after its acquisition.
    date: `${day}T${w.row.time || '12:00:00'}Z`,
    activityType: w.qty > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT',
    symbol: w.symbol,
    quantity: Math.abs(w.qty),
    unitPrice: price,
    currency: 'USD',
  })
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
    const key = [p.accountId, p.date.slice(0, 10), p.symbol, p.activityType].join('|')
    const seen = merged.get(key)
    if (seen) {
      // Weight the price by quantity, so the merged row's value is the sum of
      // the values rather than an arbitrary one of the prices.
      const total = seen.quantity + p.quantity
      seen.unitPrice = (seen.unitPrice * seen.quantity + p.unitPrice * p.quantity) / total
      seen.quantity = total
      seen.merged++
    } else merged.set(key, { ...p, merged: 1 })
  }
  return [...merged.values()]
})()

const collapsed = plan.length - mergedPlan.length
plan.length = 0
plan.push(...mergedPlan.map(({ merged, ...rest }) => rest))

writeFileSync('.local/venue-plan.json', JSON.stringify(plan, null, 1))
console.log(`venue activities planned: ${plan.length}  -> .local/venue-plan.json`)
console.log(`same-day rows merged:     ${collapsed} (would have been skipped as duplicates)`)
console.log(`prices missing: ${table.missing.length ? table.missing.join(', ') : 'none'}`)
console.log('\nskipped:')
for (const [why, n] of [...skipped].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${why}`)

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
