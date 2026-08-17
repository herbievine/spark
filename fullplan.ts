/**
 * Build the whole-history Wealthfolio import plan.
 *
 * The 2026 rebase asserted an opening balance on 1 January and replayed that
 * year on top. With history captured back to the first transaction, the opening
 * is no longer an assertion: it falls out of the movements themselves.
 *
 *   opening = today's on-chain balance − every captured movement
 *
 * A result of ~0 means the captured history explains the balance completely, so
 * no synthetic opening is booked at all and every unit in Wealthfolio traces to
 * a transaction. A positive residue means the position predates capture, and is
 * booked once at the opening date. A negative residue means an outflow was
 * missed — the history is wrong, not merely short — so `buildPlan` refuses that
 * (account, symbol) rather than inventing a number that looks plausible.
 */

import { writeFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { SparkState } from './src/state'
import { buildLedger } from './src/ledger-export'
import { buildPlan, planNet } from './src/plan'
import { WEALTHFOLIO_SYMBOLS } from './src/import'
import { Wallet } from './src/wallet'
import { WALLETS } from './src/config'
import { dailyPrices, fillForward } from './src/yahoo-prices'

const STATE = process.env.SPARK_STATE_PATH ?? '.local/spark.db'
const WF_DB = process.env.SPARK_WF_DB_PATH ?? 'backups/pre-rebase-20260817-102406/wealthfolio.db'
const OUT = process.env.SPARK_PLAN_OUT ?? '.local/full-plan.json'

/**
 * Rounding noise from summing float quantities, and genuinely dust-sized
 * residues, must not condemn a whole position as unreconciled. Anything larger
 * is a real gap and is treated as one.
 */
const tolerance = (current: number) => Math.max(1e-9, Math.abs(current) * 1e-6)

// Account ids, so the plan can name real Wealthfolio accounts.
const wf = new Database(WF_DB, { readonly: true })
const accountIds: Record<string, string> = {}
for (const r of wf
  .query<{ id: string; name: string }, []>('SELECT id, name FROM accounts WHERE is_active = 1 AND is_archived = 0')
  .all()) {
  accountIds[r.name] = r.id
}
wf.close()

const book = WALLETS.filter((w) => w.venue !== 'hyperliquid').map((w) => ({ name: w.name, address: w.address }))
const unmapped = book.filter((b) => !accountIds[b.name]).map((b) => b.name)

const state = new SparkState(STATE)
const rows = buildLedger(state, book, {})
state.close()

if (!rows.length) {
  console.error('no ledger rows — capture has not run')
  process.exit(1)
}

// Net of exactly the rows buildPlan will book, so the opening is the true residue.
const net = new Map<string, number>()
for (const r of rows) {
  if (r.doNotBook) continue
  if (!WEALTHFOLIO_SYMBOLS[r.symbol]) continue
  const q = Number(r.quantity)
  if (!(q > 0)) continue
  const key = `${r.account}|${r.symbol}`
  net.set(key, (net.get(key) ?? 0) + q * (r.direction === 'in' ? 1 : -1))
}

// Today's balances, summed across chains: Wealthfolio holds one quantity per
// symbol per account, not one per chain.
const current = new Map<string, number>()
for (const w of book) {
  const { balances } = await new Wallet(w.address as `0x${string}`).balances()
  for (const b of balances) {
    if (!WEALTHFOLIO_SYMBOLS[b.symbol]) continue
    const key = `${w.name}|${b.symbol}`
    current.set(key, (current.get(key) ?? 0) + b.quantity)
  }
}

const openings: Record<string, number> = {}
const residues: { key: string; current: number; net: number; opening: number }[] = []
for (const key of new Set([...net.keys(), ...current.keys()])) {
  const cur = current.get(key) ?? 0
  const mv = net.get(key) ?? 0
  let opening = cur - mv
  if (Math.abs(opening) <= tolerance(cur)) opening = 0
  openings[key] = opening
  residues.push({ key, current: cur, net: mv, opening })
}

const days = rows.map((r) => r.date).sort()
const openingDate = days[0]!
const symbols = [...new Set(Object.values(WEALTHFOLIO_SYMBOLS))]
const table = await dailyPrices(symbols, openingDate, new Date().toISOString().slice(0, 10))
fillForward(table, symbols, openingDate, new Date().toISOString().slice(0, 10))

const plan = buildPlan({ rows, accountIds, openings, openingDate, prices: table.prices })

writeFileSync(OUT, JSON.stringify(plan.rows, null, 1))

const names: Record<string, string> = Object.fromEntries(Object.entries(accountIds).map(([n, i]) => [i, n]))
const check = planNet(plan.rows, names)

console.log(`ledger rows      ${rows.length}  (${days[0]} .. ${days.at(-1)})`)
console.log(`plan activities  ${plan.rows.length}  -> ${OUT}`)
if (unmapped.length) console.log(`no Wealthfolio account: ${unmapped.join(', ')}`)
console.log(`prices missing:  ${table.missing.length ? table.missing.join(', ') : 'none'}`)
console.log()
console.log('skipped:')
for (const s of plan.skipped) console.log(`  ${String(s.count).padStart(4)}  ${s.reason}`)
console.log()
console.log('reconciliation (plan net vs on-chain balance):')
let bad = 0
for (const r of residues.sort((a, b) => a.key.localeCompare(b.key))) {
  const [account, sym] = r.key.split('|') as [string, string]
  if (!accountIds[account]) continue
  const planned = check.get(`${account}|${WEALTHFOLIO_SYMBOLS[sym]}`) ?? 0
  const delta = planned - r.current
  const ok = Math.abs(delta) <= tolerance(r.current)
  if (!ok) bad++
  console.log(
    `  ${ok ? 'ok  ' : 'DIFF'} ${r.key.padEnd(34)} chain ${r.current.toFixed(8).padStart(20)}  plan ${planned.toFixed(8).padStart(20)}  opening ${r.opening.toFixed(8)}`,
  )
}
console.log()
console.log(bad === 0 ? 'ALL MATCH' : `${bad} MISMATCHED`)
