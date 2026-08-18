/**
 * Book the Bitcoin wallet's history into Wealthfolio.
 *
 * No opening position is needed and none is invented: the transactions net to
 * exactly the current balance, so the history explains the holding completely —
 * the rare case where every satoshi traces to a transaction.
 *
 * Network fees are already inside each transaction's delta, because a Bitcoin
 * fee is the unspent remainder of the inputs rather than a separate transfer.
 *
 * Dry run unless SPARK_COMMIT=1.
 */
import { readFileSync } from 'node:fs'
import { Wealthfolio } from './src/wealthfolio'
import { dailyPrices, fillForward } from './src/yahoo-prices'

const COMMIT = process.env.SPARK_COMMIT === '1'
const rows = readFileSync('ledger/bitcoin-history.csv', 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split(','))
  .map(([date, txid, delta]) => ({ date: date!, txid: txid!, delta: Number(delta) }))
  .filter((r) => Math.abs(r.delta) > 0)

const wf = new Wealthfolio(process.env.SPARK_WF_URL!, process.env.SPARK_WF_TOKEN!)
await wf.connect()
const accountId = (await wf.getAccounts()).find((a) => a.name === 'Bitcoin')?.id
if (!accountId) { console.error('no Bitcoin account'); process.exit(1) }

const from = rows[0]!.date
const to = new Date().toISOString().slice(0, 10)
const table = await dailyPrices(['BTC-USD'], from, to)
fillForward(table, ['BTC-USD'], from, to)

// Merge identical same-day rows: Wealthfolio fingerprints duplicates on the
// calendar day, and 15 of these transactions share a day with another.
const merged = new Map<string, { date: string; type: string; quantity: number; price: number }>()
for (const r of rows) {
  const type = r.delta > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT'
  const key = `${r.date}|${type}`
  const price = table.prices[`BTC-USD|${r.date}`] ?? table.prices['BTC-USD'] ?? 0
  const seen = merged.get(key)
  if (seen) seen.quantity += Math.abs(r.delta)
  else merged.set(key, { date: r.date, type, quantity: Math.abs(r.delta), price })
}

const plan = [...merged.values()].map((m) => ({
  accountId,
  date: `${m.date}T12:00:00Z`,
  activityType: m.type,
  symbol: 'BTC-USD',
  quantity: m.quantity,
  unitPrice: m.price,
  currency: 'USD',
}))

const net = plan.reduce((n, p) => n + p.quantity * (p.activityType === 'TRANSFER_IN' ? 1 : -1), 0)
console.log(`transactions ${rows.length} -> ${plan.length} activities after same-day merge`)
console.log(`plan net ${net.toFixed(8)} BTC`)
console.log(`prices missing: ${table.missing.length ? table.missing.join(',') : 'none'}`)

if (!COMMIT) { console.log('DRY RUN — set SPARK_COMMIT=1 to import'); process.exit(0) }

let imported = 0
for (let i = 0; i < plan.length; i += 100) {
  const slice = plan.slice(i, i + 100).map((r, n) => ({ ...r, lineNumber: i + n + 1 }))
  const check = await wf.tool<any>('prepare_activity_import', { activities: slice })
  const ok = (check.rows ?? []).map((r: any) => r.isValid !== false && r.isDuplicate !== true)
  const toCommit = slice.filter((_, n) => ok[n])
  if (toCommit.length) { await wf.tool('commit_activity_import', { activities: toCommit }); imported += toCommit.length }
}
console.log(`IMPORTED ${imported} of ${plan.length}`)
