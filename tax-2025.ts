/**
 * French capital gains on digital assets for 2025 (art. 150 VH bis CGI).
 *
 *   gain = cession price − (total acquisition price × cession price / portfolio value)
 *
 * and after each cession the acquisition price is reduced in the same proportion,
 * so the year is computed sequentially.
 *
 * Portfolio value comes from Wealthfolio's own valuation engine over the crypto
 * accounts only, already in EUR — the reconciled history rather than a fresh
 * reconstruction, which is what makes the denominator trustworthy.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dailyPrices, fillForward } from './src/yahoo-prices'

const csv = (path: string, headerStarts: string) => {
  const lines = readFileSync(path, 'utf8').replace(/^﻿/, '').split('\n')
  const h = lines.findIndex((l) => l.startsWith(headerStarts))
  const split = (line: string) => {
    const out: string[] = []; let cur = ''; let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (c === '"') { if (q && line[i+1] === '"') { cur += '"'; i++ } else q = !q }
      else if (c === ',' && !q) { out.push(cur); cur = '' } else cur += c
    }
    out.push(cur); return out
  }
  const header = split(lines[h]!)
  return lines.slice(h+1).filter((l)=>l.trim()).map((l)=>{
    const c = split(l); const r: Record<string,string> = {}
    header.forEach((k,i)=>(r[k.trim()]=(c[i]??'').trim())); return r
  })
}
const num = (s: string) => Number((s || '0').replace(/[$,]/g, '')) || 0

// EUR/USD daily, to state everything in the currency the declaration uses.
const fx = await dailyPrices(['EURUSD=X'], '2024-01-01', '2025-12-31')
fillForward(fx, ['EURUSD=X'], '2024-01-01', '2025-12-31')
const usdToEur = (usd: number, day: string) => usd / (fx.prices[`EURUSD=X|${day}`] ?? fx.prices['EURUSD=X'] ?? 1.08)

// Portfolio value in EUR, from Wealthfolio's valuations of the crypto accounts.
const valuations: Record<string, number> = {}
for (const v of JSON.parse(readFileSync('.local/valuations.json', 'utf8'))) {
  valuations[v.valuationDate] = v.totalValueBase
}

const cb = csv('ledger/coinbase-export.csv', 'ID,Timestamp')

/** Acquisitions actually paid for in legal tender, in EUR, dated. */
const acquisitions: { date: string; eur: number; source: string }[] = []
for (const r of cb) {
  if (r['Transaction Type'] !== 'Buy') continue
  const d = r['Timestamp']!.slice(0, 10)
  acquisitions.push({ date: d, eur: usdToEur(num(r['Subtotal']!), d), source: 'Coinbase buy' })
}
for (const r of csv('ledger/binance-export.csv', 'User ID,Time')) {
  const d = r['Time']!.slice(0, 10)
  if (r['Operation'] === 'Deposit' && r['Coin'] === 'EUR') acquisitions.push({ date: d, eur: Number(r['Change']), source: 'Binance EUR deposit' })
  if (r['Operation'] === 'Buy Crypto With Fiat') acquisitions.push({ date: d, eur: usdToEur(Number(r['Change']), d), source: 'Binance fiat buy' })
}
for (const r of csv('ledger/peer-xyz-orders.csv', 'date,fiat_amount')) {
  if (r['status'] !== 'Fulfilled') continue
  const d = r['date']!
  const amt = Number(r['fiat_amount'])
  acquisitions.push({ date: d, eur: r['fiat_currency'] === 'EUR' ? amt : usdToEur(amt, d), source: 'peer.xyz' })
}
acquisitions.sort((a, b) => a.date.localeCompare(b.date))

/** Herbie's father's assets: arrived and sold same day, matching quantities. */
const DADS = new Set(['2025-03-09|BTC', '2025-03-09|ETH', '2025-03-09|ADA'])

const disposals = cb
  .filter((r) => r['Transaction Type'] === 'Sell' && r['Timestamp']!.startsWith('2025'))
  .map((r) => ({ date: r['Timestamp']!.slice(0,10), asset: r['Asset']!, proceedsUsd: num(r['Subtotal']!) }))
  .sort((a, b) => a.date.localeCompare(b.date))

let acq = 0, ai = 0, totalGain = 0, totalProceeds = 0
const out: string[] = []
console.log('date        asset  proceeds€   portfolio€   acq.cost€     gain€')
for (const d of disposals) {
  while (ai < acquisitions.length && acquisitions[ai]!.date <= d.date) acq += acquisitions[ai++]!.eur
  if (DADS.has(`${d.date}|${d.asset}`)) {
    out.push(`${d.date},${d.asset},,,,EXCLUDED (father's — same-day pass-through)`) 
    continue
  }
  const proceeds = usdToEur(d.proceedsUsd, d.date)
  const pv = valuations[d.date]
  if (pv === undefined) { out.push(`${d.date},${d.asset},${proceeds.toFixed(2)},,,NO VALUATION`); continue }
  const gain = proceeds - (acq * proceeds) / pv
  totalGain += gain; totalProceeds += proceeds
  console.log(`${d.date}  ${d.asset.padEnd(5)} ${proceeds.toFixed(2).padStart(9)} ${pv.toFixed(2).padStart(12)} ${acq.toFixed(2).padStart(11)} ${gain.toFixed(2).padStart(9)}`)
  out.push(`${d.date},${d.asset},${proceeds.toFixed(2)},${pv.toFixed(2)},${acq.toFixed(2)},${gain.toFixed(2)}`)
  acq -= (acq * proceeds) / pv
}
writeFileSync('ledger/tax-2025-france.csv', 'date,asset,proceeds_eur,portfolio_value_eur,acquisition_cost_eur,gain_eur\n' + out.join('\n') + '\n')
console.log(`\ntotal taxable proceeds (cessions)  EUR ${totalProceeds.toFixed(2)}`)
console.log(`TOTAL 2025 NET GAIN                EUR ${totalGain.toFixed(2)}`)
console.log(`tax at 30% flat (PFU)              EUR ${(Math.max(0,totalGain)*0.30).toFixed(2)}`)
console.log(`\ntotal acquisitions found: EUR ${acquisitions.reduce((n,a)=>n+a.eur,0).toFixed(2)} across ${acquisitions.length} purchases (earliest ${acquisitions[0]?.date})`)
