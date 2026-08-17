import { Wallet } from './src/wallet'
import { WALLETS } from './src/config'
import { WEALTHFOLIO_SYMBOLS } from './src/import'
import { buildPlan, planNet } from './src/plan'
import { readLedger } from './rebase'
import type { LedgerRow } from './src/ledger-export'
import { readFileSync, writeFileSync } from 'node:fs'

const IDS: Record<string,string> = {
  'Hot Wallet':'f503d44b-046b-4a0b-a35a-2ff8e667759a','Nano X':'61d1f231-9fab-409d-9e2c-413a916ab225',
  'Nano S':'9b7a0afb-ff69-43a6-a707-2963fb791e13','Multisig Wallet':'461357a4-3006-4928-91e6-5da7cc941cd0' }
const NAMES = Object.fromEntries(Object.entries(IDS).map(([k,v])=>[v,k]))

// prices: per-date where known, plus a symbol-level opening fallback
const prices: Record<string,number> = {}
for (const f of ['.local/hist-prices.json','.local/wbtc-prices.json']) {
  try { for (const [k,v] of Object.entries(JSON.parse(readFileSync(f,'utf8')) as any)) {
    prices[k.includes('|') ? k : `WBTC-USD|${k}`] = v as number } } catch {}
}
const nat = JSON.parse(readFileSync('.local/native-prices.json','utf8')) as Record<string,number>
const OPEN: Record<string,number> = { ETH:2970.028682356399, WETH:2969.578634404794, USDC:0.9993491227282315,
  XAUT:4318.183175066801, EURC:1.1737022179937668, XPL:0.16212873884616216, ...nat }
for (const [chainSym, px] of Object.entries(OPEN)) {
  const wf = WEALTHFOLIO_SYMBOLS[chainSym]; if (wf) prices[wf] = px
}

const rows = readLedger('/tmp/led3.csv') as unknown as LedgerRow[]
// openings = today's chain balance minus net 2026 movement
const net = new Map<string, number>()
for (const r of rows) {
  if (r.doNotBook || !WEALTHFOLIO_SYMBOLS[r.symbol!]) continue
  const k = `${r.account}|${r.symbol}`
  net.set(k, (net.get(k) ?? 0) + Number(r.quantity) * (r.direction === 'in' ? 1 : -1))
}
const openings: Record<string, number> = {}
const chainNow: Record<string, number> = {}
for (const w of WALLETS) {
  const { balances } = await new Wallet(w.address as `0x${string}`).balances()
  const cur = new Map<string, number>()
  for (const b of balances) if (WEALTHFOLIO_SYMBOLS[b.symbol]) cur.set(b.symbol, (cur.get(b.symbol) ?? 0) + b.quantity)
  const syms = new Set([...cur.keys(), ...[...net.keys()].filter(k=>k.startsWith(w.name+'|')).map(k=>k.split('|')[1]!)])
  for (const s of syms) {
    const now = cur.get(s) ?? 0
    chainNow[`${w.name}|${WEALTHFOLIO_SYMBOLS[s]}`] = now
    const open = now - (net.get(`${w.name}|${s}`) ?? 0)
    if (open > 1e-12) openings[`${w.name}|${s}`] = open
    else if (open < -1e-9) {
      openings[`${w.name}|${s}`] = open   // negative marks it unreconciled for the planner
      console.log(`  ! unreconciled ${w.name}/${s}: opening ${open.toFixed(10)} — an outflow was never captured`)
    }
  }
}

const plan = buildPlan({ rows, accountIds: IDS, openings, openingDate: '2026-01-01', prices })
writeFileSync('.local/plan-final.json', JSON.stringify(plan.rows, null, 1))
console.log(`plan rows: ${plan.rows.length}`)
for (const s of plan.skipped.slice(0,6)) console.log(`  skipped ${s.count}: ${s.reason}`)

console.log('\nRECONCILIATION vs chain:')
const pn = planNet(plan.rows, NAMES)
console.log('  chain keys:', Object.keys(chainNow).length, '| plan keys:', pn.size)
let bad = 0
for (const [k, chainQty] of Object.entries(chainNow)) {
  const p = pn.get(k) ?? 0
  if (Math.abs(p - chainQty) > Math.max(1e-8, Math.abs(chainQty)*1e-7)) { console.log(`  MISMATCH ${k}: plan ${p} vs chain ${chainQty}`); bad++ }
}
for (const [k, v] of pn) if (!(k in chainNow) && Math.abs(v) > 1e-9) { console.log(`  EXTRA ${k} = ${v}`); bad++ }
console.log(bad === 0 ? '  ALL MATCH' : `  ${bad} problem(s)`)
