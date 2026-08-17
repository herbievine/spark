import { Wallet } from './src/wallet'
import { WALLETS } from './src/config'
import { WEALTHFOLIO_SYMBOLS } from './src/import'
import { readLedger, netMovements } from './rebase'
const NEW = new Set(['BNB','XDAI','AVAX','WAVAX','WSTETH','POL'])
const rows = readLedger('/tmp/led2.csv')
const net = netMovements(rows, WEALTHFOLIO_SYMBOLS)
for (const w of WALLETS) {
  const { balances } = await new Wallet(w.address as `0x${string}`).balances()
  const now = new Map<string, number>()
  for (const b of balances) if (NEW.has(b.symbol)) now.set(b.symbol, (now.get(b.symbol) ?? 0) + b.quantity)
  for (const [s, cur] of now) {
    const moved = net.get(`${w.name}|${s}`) ?? 0
    console.log(`${w.name}|${s}|${WEALTHFOLIO_SYMBOLS[s]}|now=${cur}|net2026=${moved}|open=${cur - moved}`)
  }
}
