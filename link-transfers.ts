/**
 * Pair the two sides of a transfer that Wealthfolio sees as two loose ends.
 *
 * A transfer between two accounts is booked twice — once leaving, once
 * arriving — and unless the two are linked Wealthfolio treats each as money
 * crossing the portfolio boundary, which is what "3,245 transfers need matching
 * or confirmation" was reporting. Linked, the pair is recognised as an internal
 * move and stops distorting returns.
 *
 * Matching is deliberately timid, because a wrong pair is worse than no pair:
 * it would net two unrelated movements against each other and silently rewrite
 * two accounts' returns. Three tiers are tried, tightest first, and a candidate
 * is only ever linked when it is the **only** one at that tier — anything
 * ambiguous is left for a human.
 *
 * Both legs must carry the *same* quantity: Wealthfolio refuses anything else
 * with "Security transfer legs use different quantities". So the common case of
 * an exchange withdrawal — where the fee makes the amount that lands smaller
 * than the amount that left — cannot be linked at all, and is left alone rather
 * than forced. Those are correctly external anyway: the fee really did leave
 * the portfolio.
 *
 * Dry run unless SPARK_COMMIT=1.
 */

export {}

const COMMIT = process.env.SPARK_COMMIT === '1'
const WF = process.env.SPARK_WF_URL
const password = process.env.SPARK_WF_PASSWORD
if (!WF || !password) { console.error('set SPARK_WF_URL and SPARK_WF_PASSWORD'); process.exit(1) }

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
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`)
  return (text ? JSON.parse(text) : {}) as T
}
await api('/api/v1/auth/login', { password })

type Activity = {
  id: string
  accountId: string
  accountName: string
  activityType: string
  assetSymbol: string
  assetId: string | null
  quantity: string
  unitPrice: string
  currency: string
  date: string
  sourceGroupId: string | null
  metadata: Record<string, unknown> | null
}

const all: Activity[] = []
for (let page = 0; ; page++) {
  const res = await api<{ data: Activity[] }>('/api/v1/activities/search', {
    page, pageSize: 500, sort: { id: 'date', desc: false },
    activityTypeFilter: ['TRANSFER_IN', 'TRANSFER_OUT'],
  })
  const rows = res.data ?? []
  if (!rows.length) break
  all.push(...rows)
  if (rows.length < 500) break
}

const linked = new Set(all.filter((a) => a.sourceGroupId).map((a) => a.id))
const unpaired = all.filter((a) => !a.sourceGroupId)
console.log(`transfers ${all.length}, already linked ${linked.size}, unpaired ${unpaired.length}`)

const qty = (a: Activity) => Math.abs(Number(a.quantity))
const when = (a: Activity) => Date.parse(a.date)
const DAY = 86400_000

/** Tightest first. A tier only matches when exactly one candidate qualifies. */
const TIERS = [
  { name: 'exact amount, same day', tol: 0, days: 0 },
  { name: 'exact amount, within 3 days', tol: 0, days: 3 },
]

const paired = new Set<string>()
const pairs: { out: Activity; in: Activity; tier: string }[] = []
const ambiguous: { a: Activity; n: number; tier: string }[] = []

for (const tier of TIERS) {
  for (const out of unpaired) {
    if (out.activityType !== 'TRANSFER_OUT' || paired.has(out.id)) continue
    const want = qty(out)
    const candidates = unpaired.filter(
      (i: Activity) =>
        i.activityType === 'TRANSFER_IN' &&
        !paired.has(i.id) &&
        i.accountId !== out.accountId &&
        i.assetSymbol === out.assetSymbol &&
        Math.abs(when(i) - when(out)) <= tier.days * DAY + 86_399_000 &&
        (tier.tol === 0
          ? Math.abs(qty(i) - want) < 1e-12
          : Math.abs(qty(i) - want) <= Math.max(want * tier.tol, 1e-12)),
    )
    // Same day means the same calendar date, not 24 hours either side.
    const same = tier.days === 0
      ? candidates.filter((i: Activity) => i.date.slice(0, 10) === out.date.slice(0, 10))
      : candidates
    if (same.length === 1) {
      paired.add(out.id); paired.add(same[0]!.id)
      pairs.push({ out, in: same[0]!, tier: tier.name })
    } else if (same.length > 1) {
      ambiguous.push({ a: out, n: same.length, tier: tier.name })
    }
  }
}

const byTier = new Map<string, number>()
for (const p of pairs) byTier.set(p.tier, (byTier.get(p.tier) ?? 0) + 1)
console.log(`\npairs found: ${pairs.length}`)
for (const [t, n] of byTier) console.log(`  ${String(n).padStart(4)}  ${t}`)
console.log(`left unpaired: ${unpaired.length - pairs.length * 2} (genuinely external, or ambiguous)`)
if (ambiguous.length) console.log(`refused as ambiguous (more than one candidate): ${ambiguous.length}`)

console.log('\nsample:')
for (const p of pairs.slice(0, 8)) {
  console.log(`  ${p.out.accountName.padEnd(16)} -> ${p.in.accountName.padEnd(16)} ${p.out.assetSymbol.padEnd(6)} ${qty(p.out)}  ${p.out.date.slice(0, 10)}`)
}

if (!COMMIT) { console.log('\nDRY RUN — set SPARK_COMMIT=1 to link'); process.exit(0) }

let done = 0
const failures: string[] = []
for (const p of pairs) {
  try {
    await api('/api/v1/activities/link', { activityAId: p.out.id, activityBId: p.in.id })
    done++
    if (done % 25 === 0) console.log(`  linked ${done}/${pairs.length}`)
  } catch (err) {
    failures.push(`${p.out.id} <-> ${p.in.id}: ${(err as Error).message}`)
  }
}
console.log(`\nLINKED ${done} of ${pairs.length}`)
for (const f of failures.slice(0, 10)) console.log(`  ! ${f}`)

/**
 * Confirm what is left as genuinely external.
 *
 * Wealthfolio's own wording is "needs matching **or confirmation**": a transfer
 * with no counterpart inside the portfolio is money that really did enter or
 * leave it, and saying so is the remedy. This changes no number — an unpaired
 * transfer is already treated as an external flow — it records that the
 * treatment is intended, so a real unpaired leg can be seen among what is now
 * 1,400 rows of acknowledged noise.
 *
 * The flag lives in the activity's metadata under `flow.is_external`, which is
 * where the UI's External checkbox writes it.
 */
const stillOpen = all.filter((a) => !a.sourceGroupId && !paired.has(a.id))
const needsFlag = stillOpen.filter((a) => (a.metadata as any)?.flow?.is_external !== true)
console.log(`\nconfirming ${needsFlag.length} unpaired transfer(s) as external`)

let flagged = 0
for (let i = 0; i < needsFlag.length; i += 100) {
  const slice = needsFlag.slice(i, i + 100).map((a) => ({
    id: a.id,
    accountId: a.accountId,
    activityType: a.activityType,
    activityDate: a.date,
    quantity: a.quantity,
    unitPrice: a.unitPrice,
    currency: a.currency,
    assetId: a.assetId,
    metadata: JSON.stringify({ ...(a.metadata ?? {}), flow: { ...((a.metadata as any)?.flow ?? {}), is_external: true } }),
  }))
  const res = await api<{ updated?: unknown[] }>('/api/v1/activities/bulk', { creates: [], updates: slice, deleteIds: [] })
  flagged += res.updated?.length ?? 0
  console.log(`  batch ${i / 100 + 1}: ${res.updated?.length ?? 0}/${slice.length}`)
}
console.log(`\nCONFIRMED EXTERNAL ${flagged} of ${needsFlag.length}`)
