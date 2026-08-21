/**
 * Book new Hyperliquid activity from fresh CSV exports on top of what is
 * already there.
 *
 * Unlike the wallet accounts, Hyperliquid's existing history did not come from
 * Spark and is not wiped and replaced — see wipe-activities.ts. Instead this
 * appends: it reads what is already booked, finds the latest already-covered
 * moment in each of the three export files (deposits/withdrawals, funding,
 * trades), and only books what comes after. Re-running with the same or an
 * older export is a no-op.
 *
 * A perp position is not an owned asset, so a trade never becomes a BUY/SELL —
 * only its fee (always) and its realised pnl (only on a close or a flip; an
 * open's closedPnl is just -fee and would double-book the fee as a loss) become
 * their own cash activities. A spot fill (dir "Buy"/"Sell") is the rare
 * exception and is refused rather than guessed at, since it needs the same
 * disambiguated symbol lookup `HL_SYMBOLS` exists for and none has been seen
 * since the account's early days.
 *
 * CSV times are Hyperliquid's local display timezone (Europe/Paris, matching
 * this deployment); Wealthfolio activities are booked in UTC.
 *
 * Dry run unless SPARK_COMMIT=1.
 */

import { readFileSync } from 'node:fs'
import { Wealthfolio } from './src/wealthfolio'

const COMMIT = process.env.SPARK_COMMIT === '1'
const WF = process.env.SPARK_WF_URL
if (!WF) { console.error('set SPARK_WF_URL'); process.exit(1) }
const password = process.env.SPARK_WF_PASSWORD
if (!password) { console.error('set SPARK_WF_PASSWORD'); process.exit(1) }

const TZ = 'Europe/Paris'

/** Local wall-clock time in `TZ`, converted to a UTC ISO instant. */
function toUtcIso(local: string): string {
  const [d, t] = local.split(' - ')
  const [m, day, y] = d!.split('/').map(Number)
  const [hh, mm, ss] = t!.split(':').map(Number)
  const guess = Date.UTC(y!, m! - 1, day!, hh!, mm!, ss!)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(dtf.formatToParts(guess).map((x) => [x.type, x.value]))
  const asIfUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!)
  const offsetMs = asIfUtc - guess
  return new Date(guess - offsetMs).toISOString()
}

/** "1273.25 USDC" / "-4072.24 USDC" / "0.0594  ETH" -> { value, unit }. */
function parseAmount(s: string): { value: number; unit: string } {
  const parts = s.trim().split(/\s+/)
  return { value: Number(parts[0]), unit: parts[1] ?? '' }
}

function csv(path: string): Record<string, string>[] {
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  const header = lines[0]!.split(',')
  return lines.slice(1).map((l) => {
    const cells = l.split(',')
    const row: Record<string, string> = {}
    header.forEach((h, i) => (row[h] = cells[i] ?? ''))
    return row
  })
}

/** Every Hyperliquid cash activity books as quantity 1 @ unitPrice 1, so `amount` is the value. */
type Planned = {
  date: string
  activityType: string
  amount: number
  currency: string
  comment: string
}

// -------------------------------------------------------- existing activities
const wf = new Wealthfolio(WF, process.env.SPARK_WF_TOKEN!)
await wf.connect()
const accountId = (await wf.getAccounts()).find((a) => a.name === 'Hyperliquid')?.id
if (!accountId) { console.error('no Hyperliquid account'); process.exit(1) }

let cookie = ''
async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${WF}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]!
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : {}) as T
}
await api('/api/v1/auth/login', { password })

const existing: { date: string; activityType: string; comment: string | null }[] = []
for (let page = 0; ; page++) {
  const res = await api<{ data: any[] }>('/api/v1/activities/search', {
    page, pageSize: 200, accountIdFilter: [accountId], sort: { id: 'date', desc: false },
  })
  const rows = res.data ?? []
  if (!rows.length) break
  for (const r of rows) existing.push({ date: r.date, activityType: r.activityType, comment: r.comment })
  if (rows.length < 200) break
}

const maxWhere = (pred: (r: (typeof existing)[number]) => boolean) =>
  existing.filter(pred).map((r) => r.date).sort().at(-1) ?? '1970-01-01T00:00:00Z'

const dwCutoff = maxWhere((r) => (r.comment ?? '').startsWith('deposit ') || (r.comment ?? '').startsWith('withdrawal '))
const fundingCutoff = maxWhere((r) => (r.comment ?? '').startsWith('funding '))
const tradeCutoff = maxWhere((r) => (r.comment ?? '').startsWith('perp ') || (r.comment === null && ['BUY', 'SELL', 'TRANSFER_IN'].includes(r.activityType)))

console.log(`cutoffs — deposits/withdrawals ${dwCutoff}, funding ${fundingCutoff}, trades ${tradeCutoff}`)

// -------------------------------------------------------------------- deposits/withdrawals
const plan: Planned[] = []
const skipped = new Map<string, number>()
const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1)

for (const r of csv('ledger/hyperliquid-deposits.csv')) {
  const date = toUtcIso(r.time!)
  if (Date.parse(date) <= Date.parse(dwCutoff)) continue
  const change = parseAmount(r.accountValueChange!)
  if (r.action === 'deposit') {
    if (change.unit !== 'USDC') { skip(`deposit in non-USDC unit: ${change.unit}`); continue }
    plan.push({ date, activityType: 'DEPOSIT', amount: Math.abs(change.value), currency: 'USD', comment: `deposit ${r.source}->${r.destination}` })
  } else if (r.action === 'withdrawal') {
    if (change.unit !== 'USDC') { skip(`withdrawal in non-USDC unit: ${change.unit}`); continue }
    plan.push({ date, activityType: 'WITHDRAWAL', amount: Math.abs(change.value), currency: 'USD', comment: `withdrawal ${r.source}->${r.destination}` })
  } else if (r.action === 'transfer') {
    // Between Hyperliquid's own spot and perp sub-wallets: nets to zero within
    // the one Wealthfolio account they share, so there is nothing to book.
    continue
  } else {
    skip(`unhandled deposits/withdrawals action: ${r.action} (${change.value} ${change.unit})`)
  }
}

// -------------------------------------------------------------------------- funding
for (const r of csv('ledger/hyperliquid-funding.csv')) {
  const date = toUtcIso(r.time!)
  if (Date.parse(date) <= Date.parse(fundingCutoff)) continue
  const payment = Number(r.payment)
  if (!Number.isFinite(payment) || payment === 0) continue
  plan.push({
    date,
    activityType: payment > 0 ? 'INTEREST' : 'FEE',
    amount: Math.abs(payment),
    currency: 'USD',
    comment: `funding ${r.coin}`,
  })
}

// ------------------------------------------------------------------------ trades
for (const r of csv('ledger/hyperliquid-trades.csv')) {
  const date = toUtcIso(r.time!)
  if (Date.parse(date) <= Date.parse(tradeCutoff)) continue
  const dir = r.dir!
  const fee = Number(r.fee)
  const closedPnl = Number(r.closedPnl)

  if (dir === 'Buy' || dir === 'Sell') {
    skip(`spot ${dir} needs a verified symbol lookup, refusing to guess: ${r.coin} ${date}`)
    continue
  }

  if (Number.isFinite(fee) && fee !== 0) {
    plan.push({ date, activityType: 'FEE', amount: fee, currency: 'USD', comment: `perp ${r.coin} ${dir} fee` })
  }

  // An open's closedPnl is just -fee (nothing realised yet); only a close or a
  // flip realises anything worth booking.
  if (!dir.startsWith('Open') && Number.isFinite(closedPnl) && closedPnl !== 0) {
    plan.push({
      date, activityType: closedPnl > 0 ? 'CREDIT' : 'FEE', amount: Math.abs(closedPnl), currency: 'USD',
      comment: `perp ${r.coin} ${dir} pnl`,
    })
  }
}

plan.sort((a, b) => a.date.localeCompare(b.date))

console.log(`\nplanned activities: ${plan.length}`)
const byType = new Map<string, number>()
for (const p of plan) byType.set(p.activityType, (byType.get(p.activityType) ?? 0) + 1)
for (const [t, n] of byType) console.log(`  ${t.padEnd(12)} ${n}`)
if (skipped.size) {
  console.log('\nskipped:')
  for (const [why, n] of skipped) console.log(`  ${String(n).padStart(4)}  ${why}`)
}

if (!plan.length) { console.log('\nnothing new to import'); process.exit(0) }

if (!COMMIT) {
  console.log('\nDRY RUN — set SPARK_COMMIT=1 to import')
  console.log(JSON.stringify(plan.slice(0, 5), null, 1))
  process.exit(0)
}

let imported = 0
for (let i = 0; i < plan.length; i += 100) {
  const slice = plan.slice(i, i + 100).map((r, n) => ({
    accountId,
    date: r.date,
    activityType: r.activityType,
    quantity: 1,
    unitPrice: 1,
    amount: r.amount,
    currency: r.currency,
    comment: r.comment,
    lineNumber: i + n + 1,
  }))
  const check = await wf.tool<any>('prepare_activity_import', { activities: slice })
  const ok = (check.rows ?? []).map((r: any) => r.isValid !== false && r.isDuplicate !== true)
  const flagged = slice.filter((_, n) => !ok[n])
  if (flagged.length) {
    console.log(`batch ${i / 100 + 1}: flagged (not committed):`)
    for (const f of flagged) console.log(`  ${f.date} ${f.activityType} ${f.comment}`)
  }
  const toCommit = slice.filter((_, n) => ok[n])
  if (toCommit.length) { await wf.tool('commit_activity_import', { activities: toCommit }); imported += toCommit.length }
  console.log(`batch ${i / 100 + 1}: committed ${toCommit.length}/${slice.length}`)
}
console.log(`\nIMPORTED ${imported} of ${plan.length}`)
