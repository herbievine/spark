/**
 * Scan the Bitcoin wallet behind a watch-only zpub and report where it stands.
 *
 * Writes ledger/bitcoin-wallet.csv (addresses) and ledger/bitcoin-history.csv
 * (transactions, netted per transaction).
 */
import { writeFileSync } from 'node:fs'
import { zpubToXpub, scanChain, walletTransactions } from './src/bitcoin'

const zpub = process.env.SPARK_BTC_ZPUB
if (!zpub) { console.error('set SPARK_BTC_ZPUB'); process.exit(1) }

const xpub = zpubToXpub(zpub)
const receive = await scanChain(xpub, 0)
const change = await scanChain(xpub, 1)
const all = [...receive, ...change]

const balance = all.reduce((n, a) => n + a.balance, 0)
const received = all.reduce((n, a) => n + a.received, 0)
console.log(`used addresses: ${all.length}  (receive ${receive.length}, change ${change.length})`)
console.log(`total received: ${received.toFixed(8)} BTC`)
console.log(`current balance: ${balance.toFixed(8)} BTC`)

writeFileSync(
  'ledger/bitcoin-wallet.csv',
  'path,address,tx_count,received_btc,sent_btc,balance_btc\n' +
    all.map((a) => [a.path, a.address, a.txCount, a.received.toFixed(8), a.sent.toFixed(8), a.balance.toFixed(8)].join(',')).join('\n') + '\n',
)

const txs = await walletTransactions(all.map((a) => a.address))
console.log(`transactions: ${txs.length}`)
writeFileSync(
  'ledger/bitcoin-history.csv',
  'date,txid,delta_btc,fee_btc\n' +
    txs.map((t) => [new Date(t.time * 1000).toISOString().slice(0, 10), t.txid, t.delta.toFixed(8), t.fee.toFixed(8)].join(',')).join('\n') + '\n',
)
const inflow = txs.filter((t) => t.delta > 0).reduce((n, t) => n + t.delta, 0)
const outflow = txs.filter((t) => t.delta < 0).reduce((n, t) => n + t.delta, 0)
console.log(`\nin ${inflow.toFixed(8)} BTC / out ${outflow.toFixed(8)} BTC / net ${(inflow + outflow).toFixed(8)} BTC`)
if (txs.length) console.log(`first ${new Date(txs[0]!.time * 1000).toISOString().slice(0, 10)}  last ${new Date(txs.at(-1)!.time * 1000).toISOString().slice(0, 10)}`)
