/**
 * Create the Wealthfolio accounts that Spark needs but that do not exist.
 *
 * Without them there is nowhere for these balances to land, and — worse — a
 * transfer to one of them reads as money leaving the portfolio rather than moving
 * inside it. ether.fi Cash is the clearest case: it is Herbie's own top-up proxy,
 * so every payment into it was being counted as a withdrawal.
 *
 * Idempotent: an account that already exists by name is left alone.
 */

export {}

const WF = process.env.SPARK_WF_URL ?? 'https://wealth.herbievine.com'

/**
 * Accounts to ensure exist. Addresses come from `SPARK_WALLETS` rather than from
 * here: they are public on chain either way, but committing them to a public
 * repository ties them to a named GitHub account and de-anonymises every
 * transaction those wallets ever make.
 */
const addressOf = (name: string) =>
  (process.env.SPARK_WALLETS ?? '')
    .split(',')
    .map((e) => e.split(':'))
    .find((p) => p[0]?.trim() === name)?.[2]
    ?.trim() ?? null

const WANTED = [
  { name: 'Zeal', accountNumber: addressOf('Zeal') },
  // Herbie's own ether.fi Cash top-up proxy, not the protocol's shared address.
  { name: 'ether.fi Cash', accountNumber: addressOf('ether.fi Cash') },
  { name: 'MEXC', accountNumber: null },
  // Bitcoin is a wallet, not a venue, but it has no single address to record —
  // it is a zpub deriving many, so the account number stays empty.
  { name: 'Bitcoin', accountNumber: null },
  { name: 'Coinbase', accountNumber: null },
  { name: 'Binance', accountNumber: null },
]

const password = process.env.SPARK_WF_PASSWORD
if (!password) {
  console.error('set SPARK_WF_PASSWORD')
  process.exit(1)
}

let cookie = ''
async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${WF}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]!
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
  return (text ? JSON.parse(text) : {}) as T
}

await api('/api/v1/auth/login', { password })
const existing = await api<any[]>('/api/v1/accounts', undefined, 'GET')
const byName = new Map(existing.map((a) => [a.name, a]))

for (const want of WANTED) {
  const already = byName.get(want.name)
  if (already) {
    console.log(`exists   ${want.name.padEnd(16)} ${already.id}`)
    continue
  }
  const created = await api<any>('/api/v1/accounts', {
    name: want.name,
    accountType: 'SECURITIES',
    group: 'Crypto',
    currency: 'USD',
    isActive: true,
    isDefault: false,
    // Every other wallet account tracks transactions rather than a stated
    // balance, which is what makes a performance curve meaningful.
    trackingMode: 'TRANSACTIONS',
    accountNumber: want.accountNumber,
  })
  console.log(`created  ${want.name.padEnd(16)} ${created.id ?? JSON.stringify(created).slice(0, 120)}`)
}
