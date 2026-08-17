/** Opening balance at 2026-01-01 = today's chain balance minus net 2026 movement. */
import { Wallet } from './src/wallet'
import { WALLETS } from './src/config'
import { WEALTHFOLIO_SYMBOLS } from './src/import'
import { readFileSync } from 'node:fs'

const led = readFileSync('/tmp/led2.csv', 'utf8').trim().split('\n')
const hdr = led[0]!.split(',')
const rows = led.slice(1).map(l => {
  // naive split is fine: no quoted commas in the columns we read
  const c = l.split(','); const o: any = {}
  hdr.forEach((h, i) => (o[h] = c[i])); return o
})

const net = new Map<string, number>()
for (const r of rows) {
  if (r.doNotBook) continue
  if (!WEALTHFOLIO_SYMBOLS[r.symbol]) continue
  const k = `${r.account}|${r.symbol}`
  const q = Number(r.quantity) * (r.direction === 'in' ? 1 : -1)
  net.set(k, (net.get(k) ?? 0) + q)
}

for (const w of WALLETS) {
  const { balances } = await new Wallet(w.address as `0x${string}`).balances()
  const now = new Map<string, number>()
  for (const b of balances) {
    if (!WEALTHFOLIO_SYMBOLS[b.symbol]) continue
    now.set(b.symbol, (now.get(b.symbol) ?? 0) + b.quantity)
  }
  const syms = new Set([...now.keys(), ...[...net.keys()].filter(k => k.startsWith(w.name + '|')).map(k => k.split('|')[1]!)])
  for (const s of syms) {
    const cur = now.get(s) ?? 0
    const moved = net.get(`${w.name}|${s}`) ?? 0
    const open = cur - moved
    if (Math.abs(open) < 1e-9 && Math.abs(cur) < 1e-9) continue
    console.log(`${w.name}|${s}|open=${open}|now=${cur}|net2026=${moved}`)
  }
}
