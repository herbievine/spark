/**
 * Book MEXC from the only evidence there is: the chain.
 *
 * No MEXC export was provided, but two withdrawals from MEXC's hot wallets into
 * Herbie's own arrived on chain, and those are proof the funds were there. Left
 * unbooked, the money appears in a wallet from nowhere; booked, the trail runs
 * from MEXC to the wallet the way it actually happened.
 *
 * Each withdrawal is paired with an opening position the day before it, because
 * a disposal with no acquisition behind it clamps against a zero balance. The
 * pair nets to zero, which asserts MEXC is empty today — an assumption, not a
 * measurement, and the reason this prints a warning rather than staying quiet.
 * A MEXC export would replace all of this with something checked.
 *
 * Dry run unless SPARK_COMMIT=1.
 */

import { Wealthfolio } from './src/wealthfolio'
import { SparkState } from './src/state'
import { KNOWN_EXCHANGES } from './src/counterparties'
import { dailyPrices, fillForward } from './src/yahoo-prices'

const COMMIT = process.env.SPARK_COMMIT === '1'
const STATE = process.env.SPARK_STATE_PATH ?? '.local/spark.db'

/** Chain symbol -> Wealthfolio symbol, verified against the resolver. */
const SYMBOLS: Record<string, string> = { USDC: 'USDC-USD', 'USDT0?': 'USDT-USD', USDT0: 'USDT-USD', USDT: 'USDT-USD' }

const mexc = new Set(
  Object.entries(KNOWN_EXCHANGES).filter(([, v]) => v === 'MEXC').map(([k]) => k.toLowerCase()),
)

const state = new SparkState(STATE)
const rows = state.recentTransfers(100000).filter((t) => mexc.has(t.fromAddr.toLowerCase()))
state.close()

const wf = new Wealthfolio(process.env.SPARK_WF_URL!, process.env.SPARK_WF_TOKEN!)
await wf.connect()
const accountId = (await wf.getAccounts()).find((a) => a.name === 'MEXC')?.id
if (!accountId) {
  console.error('no MEXC account in Wealthfolio')
  process.exit(1)
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10)

const symbols = [...new Set(rows.map((r) => SYMBOLS[r.symbol]).filter(Boolean))] as string[]
const first = rows.length ? dayBefore(day(Math.min(...rows.map((r) => r.blockTime)))) : '2025-01-01'
const table = await dailyPrices(symbols, first, new Date().toISOString().slice(0, 10))
fillForward(table, symbols, first, new Date().toISOString().slice(0, 10))

const plan: any[] = []
for (const r of rows) {
  const symbol = SYMBOLS[r.symbol]
  if (!symbol) {
    console.log(`skipped: no verified symbol for ${r.symbol}`)
    continue
  }
  const quantity = Number(r.rawValue) / 10 ** r.decimals
  const d = day(r.blockTime)
  const price = table.prices[`${symbol}|${d}`] ?? table.prices[symbol] ?? 1
  plan.push({ accountId, date: `${dayBefore(d)}T12:00:00Z`, activityType: 'TRANSFER_IN', symbol, quantity, unitPrice: price, currency: 'USD' })
  plan.push({ accountId, date: `${d}T12:00:00Z`, activityType: 'TRANSFER_OUT', symbol, quantity, unitPrice: price, currency: 'USD' })
  console.log(`${d}  ${symbol.padEnd(9)} ${quantity.toFixed(4).padStart(12)}  withdrawn to a tracked wallet`)
}

console.log(`\nplanned ${plan.length} activities (${plan.length / 2} withdrawals, each with its opening)`)
console.log('! MEXC balance is UNVERIFIED — no export was provided, so this asserts the account is empty today.')

if (!COMMIT) {
  console.log('DRY RUN — set SPARK_COMMIT=1 to import')
  process.exit(0)
}

const check = await wf.tool<any>('prepare_activity_import', { activities: plan.map((p, i) => ({ ...p, lineNumber: i + 1 })) })
const ok = (check.rows ?? []).map((r: any) => r.isValid !== false && r.isDuplicate !== true)
const toCommit = plan.filter((_, i) => ok[i])
if (toCommit.length) await wf.tool('commit_activity_import', { activities: toCommit })
console.log(`IMPORTED ${toCommit.length} of ${plan.length}`)
