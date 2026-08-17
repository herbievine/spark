import { Wallet } from './src/wallet'
import { WALLETS } from './src/config'
import { WEALTHFOLIO_SYMBOLS } from './src/import'
import { readLedger, netMovements, OPENING_DATE, OPENING_PRICES } from './rebase'
import { writeFileSync } from 'node:fs'

const IDS: Record<string,string> = {
  'Hot Wallet':'f503d44b-046b-4a0b-a35a-2ff8e667759a',
  'Nano X':'61d1f231-9fab-409d-9e2c-413a916ab225',
  'Nano S':'9b7a0afb-ff69-43a6-a707-2963fb791e13',
  'Multisig Wallet':'461357a4-3006-4928-91e6-5da7cc941cd0',
}

const rows = readLedger('/tmp/led2.csv')
const net = netMovements(rows, WEALTHFOLIO_SYMBOLS)
const acts: any[] = []
const notes: string[] = []

// 1. opening positions
for (const w of WALLETS) {
  const accountId = IDS[w.name]; if (!accountId) continue
  const { balances } = await new Wallet(w.address as `0x${string}`).balances()
  const now = new Map<string, number>()
  for (const b of balances) if (WEALTHFOLIO_SYMBOLS[b.symbol]) now.set(b.symbol, (now.get(b.symbol) ?? 0) + b.quantity)
  const syms = new Set([...now.keys(), ...[...net.keys()].filter(k=>k.startsWith(w.name+'|')).map(k=>k.split('|')[1]!)])
  for (const s of syms) {
    const open = (now.get(s) ?? 0) - (net.get(`${w.name}|${s}`) ?? 0)
    if (open <= 1e-12) { if (open < -1e-9) notes.push(`${w.name}/${s}: opening ${open.toFixed(8)} negative -> clamped to 0 (an outflow was not captured)`); continue }
    const px = OPENING_PRICES[s]
    if (px === undefined) { notes.push(`${w.name}/${s}: no ${OPENING_DATE} price -> opening position SKIPPED`); continue }
    acts.push({ accountId, date: OPENING_DATE, activityType:'TRANSFER_IN', symbol: WEALTHFOLIO_SYMBOLS[s], quantity: open, unitPrice: px, currency:'USD' })
  }
}
const openingCount = acts.length

// 2. every 2026 movement
for (const r of rows) {
  if (r.doNotBook) continue
  const accountId = IDS[r.account!]; if (!accountId) continue
  const sym = WEALTHFOLIO_SYMBOLS[r.symbol!]; if (!sym) continue
  const q = Number(r.quantity); if (!(q > 0)) continue
  const px = OPENING_PRICES[r.symbol!]; if (px === undefined) continue
  acts.push({ accountId, date: r.date, activityType: r.direction==='in'?'TRANSFER_IN':'TRANSFER_OUT', symbol: sym, quantity: q, unitPrice: px, currency:'USD' })
}

writeFileSync('.local/rebase-plan.json', JSON.stringify(acts, null, 1))
console.log(`opening positions: ${openingCount}`)
console.log(`2026 movements:    ${acts.length - openingCount}`)
console.log(`TOTAL:             ${acts.length}`)
for (const n of notes) console.log('  ! ' + n)
