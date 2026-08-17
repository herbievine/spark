/**
 * Delete the wallet accounts' activities, so a full history can replace them.
 *
 * Appending is not an option here: the existing rows assert an opening balance on
 * 2026-01-01 that the real history contradicts, and Wealthfolio's duplicate
 * detection keys on the calendar day, so a re-import would silently keep some old
 * rows and double others. Replacing wholesale is the only version that ends in a
 * balance derived entirely from movements.
 *
 * Only the wallet accounts are touched. Hyperliquid's activities came from the
 * user's own CSV exports and are not Spark's to replace, and the equity and cash
 * accounts have nothing to do with this.
 *
 * Dry run unless SPARK_COMMIT=1.
 */

export {}

const WF = process.env.SPARK_WF_URL ?? 'https://wealth.herbievine.com'
const COMMIT = process.env.SPARK_COMMIT === '1'

/**
 * Accounts to clear. Defaults to exactly the ones Spark derives from chain data;
 * `SPARK_WIPE_ACCOUNTS` overrides it for the venue accounts, which sometimes
 * need re-importing wholesale after a mapping change.
 */
const WALLET_ACCOUNTS = (process.env.SPARK_WIPE_ACCOUNTS ?? 'Hot Wallet,Nano X,Nano S,Multisig Wallet')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const password = process.env.SPARK_WF_PASSWORD
if (!password) {
  console.error('set SPARK_WF_PASSWORD (from the `wealthfolio` Keychain item)')
  process.exit(1)
}

let cookie = ''
async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(`${WF}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]!
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : {}) as T
}

await api('/api/v1/auth/login', { password })
const accounts = await api<any[]>('/api/v1/accounts', undefined, 'GET')
const targets = accounts.filter((a) => WALLET_ACCOUNTS.includes(a.name))
if (targets.length !== WALLET_ACCOUNTS.length) {
  // A renamed account would otherwise be quietly skipped and left with stale rows
  // while everything else is replaced — a mix that is worse than either.
  console.error(`expected ${WALLET_ACCOUNTS.length} wallet accounts, found ${targets.length}`)
  process.exit(1)
}

const ids: string[] = []
for (const account of targets) {
  let page = 0
  let seen = 0
  for (;;) {
    const res = await api<{ data: any[]; totalRowCount?: number }>('/api/v1/activities/search', {
      page,
      pageSize: 200,
      accountIdFilter: [account.id],
      sort: { id: 'date', desc: true },
    })
    const rows = res.data ?? []
    if (!rows.length) break
    for (const r of rows) ids.push(r.id)
    seen += rows.length
    page++
    if (rows.length < 200) break
  }
  console.log(`${account.name.padEnd(16)} ${seen} activities`)
}

console.log(`\ntotal to delete: ${ids.length}`)

if (!COMMIT) {
  console.log('DRY RUN — set SPARK_COMMIT=1 to delete')
  process.exit(0)
}

// One batch per 100, so a failure is reported against a bounded set rather than
// leaving the whole delete in an unknown state.
let deleted = 0
for (let i = 0; i < ids.length; i += 100) {
  const slice = ids.slice(i, i + 100)
  const res = await api<{ deleted?: string[] }>('/api/v1/activities/bulk', {
    creates: [],
    updates: [],
    deleteIds: slice,
  })
  deleted += res.deleted?.length ?? 0
  console.log(`deleted batch ${i / 100 + 1}: ${res.deleted?.length ?? 0}`)
}
console.log(`\nDELETED ${deleted} of ${ids.length}`)
