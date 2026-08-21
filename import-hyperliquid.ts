/**
 * Book new Hyperliquid activity, read from the venue's own Info API.
 *
 * This replaced a CSV-driven version, because a CSV is stale the moment it is
 * exported: the first run of this script found a closed CASHCAT position worth
 * 556.65 USDC that a five-hour-old export could not have contained. The Info
 * API is keyless, needs no login, and serves the same records the exports are
 * built from, so there is nothing to download by hand and nothing to go stale.
 *
 * Unlike the wallet accounts, Hyperliquid's history did not come from Spark and
 * is not wiped and replaced — see wipe-activities.ts. This appends: it reads
 * what is already booked, takes the latest already-covered moment in each
 * category, and books only what is newer. Re-running changes nothing.
 *
 * A perp position is not an owned asset, so a trade never becomes a BUY/SELL —
 * only its fee (always) and its realised pnl (only on a close or a flip; an
 * open's closedPnl is just -fee and would double-book the fee as a loss) become
 * cash activities. A spot fill is refused rather than guessed at, since it needs
 * the disambiguated symbol lookup `HL_SYMBOLS` exists for.
 *
 * Unrealised pnl on open positions is booked separately and refreshed on every
 * run — see `syncUnrealised` below for why that is a single replaceable row
 * rather than an append.
 *
 * Dry run unless SPARK_COMMIT=1.
 */

import { Wealthfolio } from './src/wealthfolio'
import { Hyperliquid } from './src/hyperliquid'

const COMMIT = process.env.SPARK_COMMIT === '1'
const WF = process.env.SPARK_WF_URL
if (!WF) { console.error('set SPARK_WF_URL'); process.exit(1) }
const password = process.env.SPARK_WF_PASSWORD
if (!password) { console.error('set SPARK_WF_PASSWORD'); process.exit(1) }

const ADDRESS = (process.env.SPARK_WALLETS ?? '')
  .split(',')
  .map((e) => e.split(':'))
  .find((p) => p[1]?.trim() === 'hyperliquid')?.[2]
  ?.trim()
if (!ADDRESS) { console.error('no hyperliquid wallet in SPARK_WALLETS'); process.exit(1) }

/** Marks the one row that carries unrealised pnl, so it can be found and replaced. */
const UNREALISED_COMMENT = 'unrealised perp pnl (refreshed each sync)'

const INFO_URL = 'https://api.hyperliquid.xyz/info'
async function info<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Hyperliquid ${body.type} failed: ${res.status}`)
  return (await res.json()) as T
}

type Planned = { date: string; activityType: string; amount: number; currency: string; comment: string }

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

type Existing = { id: string; date: string; activityType: string; comment: string | null }
const existing: Existing[] = []
for (let page = 0; ; page++) {
  const res = await api<{ data: any[] }>('/api/v1/activities/search', {
    page, pageSize: 200, accountIdFilter: [accountId], sort: { id: 'date', desc: false },
  })
  const rows = res.data ?? []
  if (!rows.length) break
  for (const r of rows) existing.push({ id: r.id, date: r.date, activityType: r.activityType, comment: r.comment })
  if (rows.length < 200) break
}

/** Latest booked instant in a category, as epoch ms. 0 when the category is empty. */
const cutoff = (pred: (r: Existing) => boolean): number => {
  const dates = existing.filter(pred).map((r) => Date.parse(r.date))
  return dates.length ? Math.max(...dates) : 0
}

const isUnrealised = (r: Existing) => r.comment === UNREALISED_COMMENT
const ledgerCutoff = cutoff((r) => (r.comment ?? '').startsWith('deposit ') || (r.comment ?? '').startsWith('withdrawal '))
const fundingCutoff = cutoff((r) => (r.comment ?? '').startsWith('funding '))
const tradeCutoff = cutoff(
  (r) => (r.comment ?? '').startsWith('perp ') ||
    (r.comment === null && ['BUY', 'SELL', 'TRANSFER_IN'].includes(r.activityType)),
)

const iso = (ms: number) => new Date(ms).toISOString()
console.log(`cutoffs — ledger ${iso(ledgerCutoff)}, funding ${iso(fundingCutoff)}, trades ${iso(tradeCutoff)}`)

const plan: Planned[] = []
const skipped = new Map<string, number>()
const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1)

// ------------------------------------------------------------------- fills
/**
 * Fills come in pages of at most 2,000, newest last. One order routinely
 * produces several fills at the same instant, which Wealthfolio would see as
 * same-day duplicates, so they are summed per (second, coin, direction) — the
 * "(N fills)" note matches how the pre-existing rows were labelled.
 */
type Fill = { time: number; coin: string; dir: string; fee: string; closedPnl: string }
const fills: Fill[] = []
for (let startTime = tradeCutoff + 1; ; ) {
  const page = await info<Fill[]>({ type: 'userFillsByTime', user: ADDRESS, startTime })
  if (!page.length) break
  fills.push(...page)
  if (page.length < 2000) break
  startTime = Math.max(...page.map((f) => f.time)) + 1
}

const grouped = new Map<string, { time: number; coin: string; dir: string; fee: number; pnl: number; n: number }>()
for (const f of fills) {
  if (f.time <= tradeCutoff) continue
  const key = `${Math.floor(f.time / 1000)}|${f.coin}|${f.dir}`
  const g = grouped.get(key) ?? { time: f.time, coin: f.coin, dir: f.dir, fee: 0, pnl: 0, n: 0 }
  g.fee += Number(f.fee)
  g.pnl += Number(f.closedPnl)
  g.n++
  grouped.set(key, g)
}

for (const g of grouped.values()) {
  if (g.dir === 'Buy' || g.dir === 'Sell') {
    skip(`spot ${g.dir} needs a verified symbol lookup, refusing to guess: ${g.coin}`)
    continue
  }
  const date = iso(g.time)
  const fills = g.n > 1 ? ` (${g.n} fills)` : ''
  if (g.fee !== 0) {
    plan.push({ date, activityType: 'FEE', amount: Math.abs(g.fee), currency: 'USD', comment: `perp ${g.coin} ${g.dir} fee${fills}` })
  }
  // An open's closedPnl is only the fee restated; nothing is realised yet.
  if (!g.dir.startsWith('Open') && g.pnl !== 0) {
    plan.push({
      date, activityType: g.pnl > 0 ? 'CREDIT' : 'FEE', amount: Math.abs(g.pnl), currency: 'USD',
      comment: `perp ${g.coin} ${g.dir} pnl${fills}`,
    })
  }
}

// ----------------------------------------------------------------- funding
type Funding = { time: number; delta: { coin: string; usdc: string } }
const funding = await info<Funding[]>({ type: 'userFunding', user: ADDRESS, startTime: fundingCutoff + 1 })
for (const f of funding) {
  if (f.time <= fundingCutoff) continue
  const usdc = Number(f.delta.usdc)
  if (!Number.isFinite(usdc) || usdc === 0) continue
  plan.push({
    date: iso(f.time),
    activityType: usdc > 0 ? 'INTEREST' : 'FEE',
    amount: Math.abs(usdc),
    currency: 'USD',
    comment: `funding ${f.delta.coin}`,
  })
}

// ------------------------------------------------- deposits and withdrawals
type Ledger = { time: number; delta: { type: string; usdc?: string; amount?: string; token?: string } }
const ledger = await info<Ledger[]>({ type: 'userNonFundingLedgerUpdates', user: ADDRESS, startTime: ledgerCutoff + 1 })
for (const l of ledger) {
  // Compared at second granularity, unlike fills and funding. One arrival is
  // reported twice by the two sources — the exports call it a `deposit`, the
  // API a `send` from the bridge — and the API's copy carries sub-second
  // milliseconds that clear a millisecond cutoff. Wealthfolio stores seconds,
  // so anything inside the last booked second is already covered.
  if (Math.floor(l.time / 1000) <= Math.floor(ledgerCutoff / 1000)) continue
  const type = l.delta.type
  // Moves between the spot and perp sub-wallets net to zero inside the one
  // Wealthfolio account they share, so there is nothing to book.
  if (type === 'internalTransfer' || type === 'accountClassTransfer' || type === 'spotTransfer') continue
  const usdc = Number(l.delta.usdc ?? l.delta.amount ?? '0')
  if (!Number.isFinite(usdc) || usdc === 0) { skip(`ledger ${type} with no USDC amount`); continue }
  if (type === 'deposit') {
    plan.push({ date: iso(l.time), activityType: 'DEPOSIT', amount: Math.abs(usdc), currency: 'USD', comment: 'deposit arbitrum->trading' })
  } else if (type === 'withdraw') {
    plan.push({ date: iso(l.time), activityType: 'WITHDRAWAL', amount: Math.abs(usdc), currency: 'USD', comment: 'withdrawal trading->arbitrum' })
  } else {
    skip(`unhandled ledger type: ${type}`)
  }
}

/**
 * Merge rows Wealthfolio would fingerprint as one.
 *
 * Duplicates are keyed on the calendar day, so two identical amounts for the
 * same coin on one day are read as one row repeated and the second is silently
 * dropped — three funding rows vanished exactly this way before this existed.
 * Summing keeps the total truthful and presents one row it will accept.
 */
const merged = new Map<string, Planned>()
for (const p of plan) {
  const key = [p.date.slice(0, 10), p.activityType, p.comment, p.amount.toFixed(6)].join('|')
  const seen = merged.get(key)
  if (seen) seen.amount += p.amount
  else merged.set(key, { ...p })
}
const collapsed = plan.length - merged.size

/**
 * Drop rows already booked, before Wealthfolio has to judge them.
 *
 * A cursor sits on a whole second while these events carry milliseconds, so the
 * last second before a cutoff is re-proposed on every run. Wealthfolio would
 * refuse those as duplicates and be right — but its fingerprint is the calendar
 * day, so it would equally refuse a genuinely new row that happens to match an
 * earlier amount. Filtering here on the exact instant means anything it still
 * refuses is a real anomaly rather than noise to be scrolled past.
 */
const alreadyBooked = new Set(
  existing.map((r) => [Date.parse(r.date), r.activityType, r.comment].join('|')),
)
const finalPlan = [...merged.values()]
  .filter((p) => {
    const key = [Math.floor(Date.parse(p.date) / 1000) * 1000, p.activityType, p.comment].join('|')
    return !alreadyBooked.has(key)
  })
  .sort((a, b) => a.date.localeCompare(b.date))
const preBooked = merged.size - finalPlan.length

console.log(
  `\nnew activities: ${finalPlan.length}` +
    `${collapsed ? `  (${collapsed} same-day identical rows merged)` : ''}` +
    `${preBooked ? `  (${preBooked} already booked)` : ''}`,
)
const byType = new Map<string, number>()
for (const p of finalPlan) byType.set(p.activityType, (byType.get(p.activityType) ?? 0) + 1)
for (const [t, n] of byType) console.log(`  ${t.padEnd(10)} ${n}`)
if (skipped.size) {
  console.log('skipped:')
  for (const [why, n] of skipped) console.log(`  ${String(n).padStart(4)}  ${why}`)
}

/**
 * Book unrealised pnl as one replaceable row.
 *
 * Hyperliquid holds an open position's unrealised pnl inside the margin it
 * reports, so venue equity includes it while Wealthfolio — which only ever sees
 * realised events — does not. Left alone the account reads low by exactly that
 * much: 3,718 against a real 4,862 the day this was written.
 *
 * It cannot be appended like everything else, because it is a running mark
 * rather than an event: the previous row is deleted and a fresh one written on
 * every sync, so the account always carries today's mark and never a stack of
 * yesterday's. Deletion is REST-only — MCP exposes no delete.
 */
async function syncUnrealised(): Promise<void> {
  const state = await new Hyperliquid().state(ADDRESS!)
  const pnl = state.unrealizedPnl
  const stale = existing.filter(isUnrealised)

  console.log(`\nunrealised pnl ${pnl.toFixed(2)} across ${state.openPerpPositions} open position(s)`)
  if (stale.length) console.log(`  replacing ${stale.length} previous mark(s)`)
  if (!COMMIT) return

  if (stale.length) {
    await api('/api/v1/activities/bulk', { creates: [], updates: [], deleteIds: stale.map((r) => r.id) })
  }
  if (Math.abs(pnl) < 0.005) return

  const row = {
    accountId,
    date: new Date().toISOString(),
    activityType: pnl > 0 ? 'CREDIT' : 'FEE',
    quantity: 1,
    unitPrice: 1,
    amount: Math.abs(pnl),
    currency: 'USD',
    comment: UNREALISED_COMMENT,
    lineNumber: 1,
  }
  const check = await wf.tool<any>('prepare_activity_import', { activities: [row] })
  const ok = (check.rows ?? [])[0]
  if (ok && ok.isValid !== false && ok.isDuplicate !== true) {
    await wf.tool('commit_activity_import', { activities: [row] })
    console.log('  booked the current mark')
  } else {
    console.log(`  ! mark refused: ${JSON.stringify(ok)}`)
  }
}

if (!COMMIT) {
  await syncUnrealised()
  console.log('\nDRY RUN — set SPARK_COMMIT=1 to import')
  process.exit(0)
}

let imported = 0
for (let i = 0; i < finalPlan.length; i += 100) {
  const slice = finalPlan.slice(i, i + 100).map((r, n) => ({
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
  for (const [n, row] of slice.entries()) {
    if (!ok[n]) console.log(`  ! refused ${row.date} ${row.activityType} ${row.comment}`)
  }
  const toCommit = slice.filter((_, n) => ok[n])
  if (toCommit.length) { await wf.tool('commit_activity_import', { activities: toCommit }); imported += toCommit.length }
}
console.log(`\nIMPORTED ${imported} of ${finalPlan.length}`)

await syncUnrealised()
