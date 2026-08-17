/**
 * Flag every movement whose sender or receiver Spark cannot name.
 *
 * A named counterparty is what turns a transfer into a story: money moved to an
 * exchange, to another of Herbie's wallets, into a protocol. An unnamed one is
 * either a gap in the address book or something that deserves a look — and the
 * two are indistinguishable until someone checks, so the honest move is to list
 * them rather than let them blend into the ledger.
 *
 * Rows already refused by the ledger (spam, forged transfers, dust attacks) are
 * excluded: their counterparty is unknown *by construction*, and including them
 * would bury the handful that matter under hundreds that do not.
 *
 * Writes ledger/unknown-counterparties.csv, ranked by how much moved.
 */

import { writeFileSync } from 'node:fs'
import { SparkState } from './src/state'
import { buildLedger } from './src/ledger-export'
import { WALLETS, KNOWN_COUNTERPARTIES, VENUE_LABELS } from './src/config'
import { KNOWN_EXCHANGES } from './src/counterparties'

const STATE = process.env.SPARK_STATE_PATH ?? '.local/spark.db'

const own = new Map(WALLETS.map((w) => [w.address.toLowerCase(), w.name]))
const known = (address: string): string | null => {
  const a = address.toLowerCase()
  return (
    own.get(a) ??
    KNOWN_EXCHANGES[a] ??
    KNOWN_COUNTERPARTIES[a] ??
    VENUE_LABELS[a] ??
    (a === '0x0000000000000000000000000000000000000000' ? 'mint/burn' : null)
  )
}

const state = new SparkState(STATE)
const book = WALLETS.filter((w) => w.venue !== 'hyperliquid').map((w) => ({ name: w.name, address: w.address }))
const rows = buildLedger(state, book, {})
state.close()

type Entry = {
  address: string
  chains: Set<number>
  legs: number
  assets: Set<string>
  first: string
  last: string
  inbound: number
  outbound: number
  sample: string
}

const unknown = new Map<string, Entry>()
let checked = 0
for (const r of rows) {
  if (r.doNotBook) continue // spam and forgeries: unknown by construction
  checked++
  const cp = r.counterparty
  if (!cp || known(cp)) continue
  const key = cp.toLowerCase()
  const e =
    unknown.get(key) ??
    ({ address: cp, chains: new Set(), legs: 0, assets: new Set(), first: r.date, last: r.date, inbound: 0, outbound: 0, sample: r.txHash } as Entry)
  e.chains.add(r.chainId)
  e.assets.add(r.symbol)
  e.legs++
  if (r.date < e.first) e.first = r.date
  if (r.date > e.last) e.last = r.date
  if (r.direction === 'in') e.inbound++
  else e.outbound++
  unknown.set(key, e)
}

// Ask the explorers what these addresses are before calling any of them unknown.
const { resolveNames } = await import('./resolve-counterparties')
const names = await resolveNames(
  [...unknown.values()].map((e) => ({ address: e.address, chainId: [...e.chains][0]! })),
)

const list = [...unknown.values()].sort((a, b) => b.legs - a.legs)
/**
 * A named contract is identified, not unknown. An unnamed contract is unverified
 * but still a contract. An address with no code is somebody's wallet — that is
 * the set worth a human's attention.
 */
const classify = (address: string) => {
  const n = names[address.toLowerCase()]
  if (!n) return { kind: 'unresolved', label: '' }
  if (n.name) return { kind: 'named contract', label: n.name }
  return { kind: n.isContract ? 'unverified contract' : 'wallet (no contract code)', label: '' }
}

const head = 'address,kind,label,legs,inbound,outbound,chains,assets,first_seen,last_seen,sample_tx'
const body = list
  .map((e) =>
    [e.address, classify(e.address).kind, classify(e.address).label, e.legs, e.inbound, e.outbound, [...e.chains].join(' '), [...e.assets].join(' '), e.first, e.last, e.sample]
      .map((v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)))
      .join(','),
  )
  .join('\n')
writeFileSync('ledger/unknown-counterparties.csv', `${head}\n${body}\n`)

console.log(`ledger legs considered (excluding refused): ${checked}`)
console.log(`distinct unknown counterparties:            ${list.length}`)
console.log(`legs touching an unknown counterparty:      ${list.reduce((n, e) => n + e.legs, 0)}`)
const counts = new Map<string, number>()
for (const e of list) counts.set(classify(e.address).kind, (counts.get(classify(e.address).kind) ?? 0) + 1)
console.log('\nby kind:')
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)

console.log('\nunidentified wallets, by activity — the set that needs a human:')
for (const e of list.filter((x) => classify(x.address).kind === 'wallet (no contract code)').slice(0, 15)) {
  console.log(
    `  ${e.address}  ${String(e.legs).padStart(3)} legs  in ${e.inbound}/out ${e.outbound}  chains ${[...e.chains].join(',')}  ${[...e.assets].slice(0, 4).join(' ')}  ${e.first}..${e.last}`,
  )
}
