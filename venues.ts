/**
 * Normalise the venue exports, and bind every on-chain movement to its off-chain
 * counterpart.
 *
 * An exchange withdrawal and the transfer that arrives on chain are one movement
 * seen from two sides. Booking both would double it; booking neither loses the
 * link between the fiat that went in and the tokens that came out. So each venue
 * record that should have a chain leg is matched to one — asset, amount and time
 * — and what fails to match is reported rather than quietly dropped.
 *
 * Writes:
 *   ledger/venue-movements.csv    every venue record, with its chain match
 *   ledger/unmatched.csv          the ones with no counterpart, and why
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { Database } from 'bun:sqlite'

const STATE = process.env.SPARK_STATE_PATH ?? '.local/spark.db'

type Movement = {
  venue: string
  date: string
  time: string
  kind: string
  asset: string
  /** Signed: positive is into the venue account, negative is out. */
  quantity: number
  fiat: string
  fiatAmount: string
  counterparty: string
  note: string
  /** Whether this record should have a transfer on chain behind it. */
  expectsChain: boolean
  matchTx: string
  matchChain: string
  matchNote: string
}

const csv = (path: string, headerStartsWith: string) => {
  const lines = readFileSync(path, 'utf8').replace(/^﻿/, '').split('\n')
  const h = lines.findIndex((l) => l.startsWith(headerStartsWith))
  const parse = (line: string) => {
    const out: string[] = []
    let cur = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
      else if (c === ',' && !q) { out.push(cur); cur = '' }
      else cur += c
    }
    out.push(cur)
    return out
  }
  const header = parse(lines[h]!)
  return lines.slice(h + 1).filter((l) => l.trim()).map((l) => {
    const cells = parse(l)
    const row: Record<string, string> = {}
    header.forEach((k, i) => (row[k.trim()] = (cells[i] ?? '').trim()))
    return row
  })
}

const movements: Movement[] = []

// ---------------------------------------------------------------- Coinbase
// Sends and receives are on-chain and carry addresses. Buys, sells, converts and
// staking income happen inside Coinbase and have no chain leg by definition.
const CB_ONCHAIN = new Set(['Send', 'Receive'])
for (const r of csv('ledger/coinbase-export.csv', 'ID,Timestamp')) {
  const ts = r['Timestamp']?.replace(' UTC', '') ?? ''
  const [date, time] = ts.split(' ')
  const qty = Number(r['Quantity Transacted'] ?? '0')
  const type = r['Transaction Type'] ?? ''
  if (!date || !Number.isFinite(qty)) continue
  movements.push({
    venue: 'Coinbase',
    date,
    time: time ?? '',
    kind: type,
    asset: r['Asset'] ?? '',
    // Coinbase reports Send as a negative quantity already.
    quantity: qty,
    fiat: r['Price Currency'] ?? '',
    fiatAmount: r['Total (inclusive of fees and/or spread)'] ?? '',
    counterparty: r['Recipient Address'] || r['Sender Address'] || '',
    note: (r['Notes'] ?? '').slice(0, 120),
    expectsChain: CB_ONCHAIN.has(type),
    matchTx: '',
    matchChain: '',
    matchNote: '',
  })
}

// ----------------------------------------------------------------- Binance
// The export has no addresses, so deposits and withdrawals match on asset,
// amount and time alone. Everything else — Simple Earn interest, converts,
// auto-invest — is internal to Binance and has no chain leg.
const BN_ONCHAIN = new Set(['Deposit', 'Withdraw'])
for (const r of csv('ledger/binance-export.csv', 'User ID,Time')) {
  const [date, time] = (r['Time'] ?? '').split(' ')
  const change = Number(r['Change'] ?? '0')
  const op = r['Operation'] ?? ''
  if (!date || !Number.isFinite(change)) continue
  movements.push({
    venue: 'Binance',
    date,
    time: time ?? '',
    kind: op,
    asset: r['Coin'] ?? '',
    quantity: change,
    fiat: '',
    fiatAmount: '',
    counterparty: '',
    note: (r['Remark'] ?? '').slice(0, 80),
    expectsChain: BN_ONCHAIN.has(op),
    matchTx: '',
    matchChain: '',
    matchNote: '',
  })
}

// ---------------------------------------------------------------- peer.xyz
for (const r of csv('ledger/peer-xyz-orders.csv', 'date,fiat_amount')) {
  const fulfilled = r['status'] === 'Fulfilled'
  movements.push({
    venue: 'peer.xyz',
    date: r['date'] ?? '',
    time: '',
    kind: `${r['type']} ${r['status']}`,
    asset: r['asset'] ?? 'USDC',
    quantity: Number(r['asset_received'] || r['asset_ordered'] || '0'),
    fiat: r['fiat_currency'] ?? '',
    fiatAmount: r['fiat_amount'] ?? '',
    counterparty: r['destination'] ?? '',
    note: r['note'] ?? '',
    // An expired order never settled, so it must NOT have a chain leg.
    expectsChain: fulfilled,
    matchTx: r['tx_hash']?.includes('…') ? '' : (r['tx_hash'] ?? ''),
    matchChain: r['chain'] ?? '',
    matchNote: r['matched_onchain'] === 'yes' ? 'matched by transaction hash' : '',
  })
}

// ------------------------------------------------------- match against chain
const db = new Database(STATE, { readonly: true })
const chain = db
  .query<{ chain_id: number; tx_hash: string; symbol: string; qty: number; day: string; ts: number }, []>(
    `SELECT chain_id, tx_hash, symbol,
            CAST(raw_value AS REAL)/POWER(10, decimals) AS qty,
            date(block_time,'unixepoch') AS day, block_time AS ts
       FROM transfers`,
  )
  .all()
db.close()

/** Coinbase and Binance use their own tickers for the same asset. */
const ALIAS: Record<string, string> = { ETH2: 'ETH', USDT: 'USDT0', MATIC: 'POL' }
const norm = (s: string) => (ALIAS[s.toUpperCase()] ?? s).toUpperCase().replace(/\?$/, '')

/**
 * Coinbase calls Coinbase Wrapped BTC simply "BTC". Sent to an EVM address it is
 * cbBTC on Base, not bitcoin — which is why 0.1 BTC of sends to the Hot Wallet
 * looked like they had no chain leg at all.
 */
const assetFor = (m: Movement) =>
  norm(m.asset) === 'BTC' && m.counterparty.startsWith('0x') ? 'CBBTC' : norm(m.asset)

const used = new Set<string>()
let matched = 0
for (const m of movements) {
  if (!m.expectsChain || m.matchTx) continue
  const want = Math.abs(m.quantity)
  const when = Date.parse(`${m.date}T${m.time || '00:00:00'}Z`) / 1000
  const asset = assetFor(m)

  const hit = chain.find((c) => {
    const key = `${c.chain_id}:${c.tx_hash}`
    if (used.has(key)) return false
    if (norm(c.symbol) !== asset) return false
    if (Math.abs(c.ts - when) > 3 * 86400) return false
    // Withdrawal fees mean the amount that lands is a little short of the amount
    // the venue reports, so an exact equality would miss most real matches.
    const diff = Math.abs(c.qty - want)
    return diff <= Math.max(want * 0.02, 1e-8)
  })

  if (hit) {
    used.add(`${hit.chain_id}:${hit.tx_hash}`)
    m.matchTx = hit.tx_hash
    m.matchChain = String(hit.chain_id)
    m.matchNote = Math.abs(hit.qty - want) > 1e-9 ? `chain amount ${hit.qty} vs venue ${want}` : 'exact'
    matched++
  } else {
    m.matchNote = 'no chain transfer found'
  }
}

const head =
  'venue,date,time,kind,asset,quantity,fiat,fiat_amount,counterparty,expects_chain,match_chain,match_tx,match_note,note'
const esc = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const body = movements
  .sort((a, b) => `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`))
  .map((m) =>
    [m.venue, m.date, m.time, m.kind, m.asset, m.quantity, m.fiat, m.fiatAmount, m.counterparty,
      m.expectsChain ? 'yes' : 'no', m.matchChain, m.matchTx, m.matchNote, m.note].map((v) => esc(String(v))).join(','),
  )
  .join('\n')
writeFileSync('ledger/venue-movements.csv', `${head}\n${body}\n`)

const unmatched = movements.filter((m) => m.expectsChain && !m.matchTx)
writeFileSync(
  'ledger/unmatched.csv',
  `${head}\n${unmatched.map((m) => [m.venue, m.date, m.time, m.kind, m.asset, m.quantity, m.fiat, m.fiatAmount, m.counterparty, 'yes', '', '', m.matchNote, m.note].map((v) => esc(String(v))).join(',')).join('\n')}\n`,
)

const byVenue = new Map<string, { total: number; onchain: number; matched: number }>()
for (const m of movements) {
  const e = byVenue.get(m.venue) ?? { total: 0, onchain: 0, matched: 0 }
  e.total++
  if (m.expectsChain) e.onchain++
  if (m.expectsChain && m.matchTx) e.matched++
  byVenue.set(m.venue, e)
}
console.log('venue            records  on-chain  matched')
for (const [v, e] of byVenue) {
  console.log(`${v.padEnd(16)} ${String(e.total).padStart(7)} ${String(e.onchain).padStart(9)} ${String(e.matched).padStart(8)}`)
}
console.log(`\nwrote ledger/venue-movements.csv (${movements.length}) and ledger/unmatched.csv (${unmatched.length})`)
