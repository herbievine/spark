import { Hono } from 'hono'
import { buildDefiReport, buildReport, renderDefiText, renderText } from './report'
import { track, renderTrack } from './track'
import { SparkState } from './state'
import { classify, renderMovements } from './movements'
import { loadAddressBook } from './address-book'

/**
 * Credentials come from the environment in production and from the macOS
 * Keychain in local development, so the token never lands in a file on either.
 */
function secret(envVar: string, keychainService: string): string {
  const fromEnv = process.env[envVar]
  if (fromEnv) return fromEnv

  const found = Bun.spawnSync([
    'security',
    'find-generic-password',
    '-a',
    process.env.USER ?? '',
    '-s',
    keychainService,
    '-w',
  ])
  const value = found.success ? new TextDecoder().decode(found.stdout).trim() : ''
  if (!value) throw new Error(`missing credential: set ${envVar} or add ${keychainService} to the Keychain`)
  return value
}

const dbPath = () => process.env.SPARK_WF_DB_PATH ?? '/data/wealthfolio.db'
/** Spark's own state. Separate from Wealthfolio's database, and written to. */
const statePath = () => process.env.SPARK_STATE_PATH ?? '/state/spark.db'
const trackOpts = () => ({ dbPath: dbPath(), statePath: statePath() })

const config = () => ({
  dbPath: dbPath(),
  statePath: statePath(),
  baseUrl: process.env.SPARK_WF_URL ?? 'http://localhost:8088',
  token: secret('SPARK_WF_TOKEN', 'spark-wf-token'),
})

const app = new Hono()

app.get('/health', (c) => c.json({ ok: true }))

app.get('/report', async (c) => {
  const report = await buildReport(config())
  if (c.req.query('format') === 'json') return c.json(report)
  return c.text(renderText(report))
})

/**
 * Job B on its own route and its own cadence — daily, not every 30 minutes.
 * Needs no credentials at all: contract reads require no key.
 */
app.get('/tracker', async (c) => {
  const state = new SparkState(statePath())
  const body = { stats: state.stats(), recent: state.recentTransfers(50) }
  state.close()
  return c.json(body)
})

/** Captured transfers, interpreted. Re-runnable: classification is not baked in. */
app.get('/movements', (c) => {
  const state = new SparkState(statePath())
  const { accounts } = loadAddressBook(dbPath())
  const movements = classify(state, accounts, Number(c.req.query('limit') ?? 500))
  state.close()
  if (c.req.query('format') === 'json') return c.json(movements)
  return c.text(renderMovements(movements))
})

app.get('/ledger', async (c) => {
  const { buildLedger, toCsv } = await import('./ledger-export')
  const state = new SparkState(statePath())
  const { accounts } = loadAddressBook(dbPath())
  const rows = buildLedger(state, accounts, { year: Number(c.req.query('year')) || undefined })
  state.close()
  if (c.req.query('format') === 'csv') return c.text(toCsv(rows))
  return c.json(rows)
})

app.get('/defi', async (c) => {
  const report = await buildDefiReport({ dbPath: dbPath() })
  if (c.req.query('format') === 'json') return c.json(report)
  return c.text(renderDefiText(report))
})

// `bun run src/index.ts <report|defi>` prints and exits — the form cron runs.
if (process.argv[2] === 'report') {
  const report = await buildReport(config())
  console.log(renderText(report))
  process.exit(report.alerts.length > 0 ? 1 : 0)
}

// `ledger [year] [csv|json]` — the auditable money-movement ledger.
if (process.argv[2] === 'ledger') {
  const { buildLedger, toCsv, summarise } = await import('./ledger-export')
  const year = Number(process.argv[3]) || undefined
  const format = process.argv[4] ?? 'summary'
  const state = new SparkState(statePath())
  const { accounts } = loadAddressBook(dbPath())
  const rows = buildLedger(state, accounts, { year })
  state.close()
  if (format === 'csv') console.log(toCsv(rows))
  else if (format === 'json') console.log(JSON.stringify(rows, null, 2))
  else {
    console.log(`Spark ledger${year ? ' — ' + year : ''}: ${rows.length} legs`)
    console.log()
    console.log(summarise(rows))
  }
  process.exit(0)
}

// `import-plan [year]` — dry run: what would be booked, and what is refused.
if (process.argv[2] === 'import-plan') {
  const { buildLedger } = await import('./ledger-export')
  const { planImport } = await import('./import')
  const { historicalPrices } = await import('./histprices')
  const year = Number(process.argv[3]) || 2026
  const state = new SparkState(statePath())
  const { accounts } = loadAddressBook(dbPath())
  const rows = buildLedger(state, accounts, { year })
  state.close()
  const ids = JSON.parse(process.env.SPARK_WF_ACCOUNT_IDS ?? '{}')
  const prices = await historicalPrices(rows)
  const plan = planImport(rows, ids, prices)
  console.log(JSON.stringify(plan, null, 1))
  process.exit(0)
}

// `resolve-symbols` — recover token names on rows captured before the contract
// was known. Safe to re-run; it only touches UNKNOWN: stubs.
if (process.argv[2] === 'resolve-symbols') {
  const { resolveSymbols } = await import('./resolve-symbols')
  const r = await resolveSymbols(statePath())
  console.log(`contracts seen ${r.contractsSeen}, resolved ${r.contractsResolved}, rows updated ${r.rowsUpdated}`)
  for (const f of r.failures.slice(0, 10)) console.log(`  ! ${f}`)
  if (r.failures.length > 10) console.log(`  … ${r.failures.length - 10} more`)
  process.exit(0)
}

if (process.argv[2] === 'movements') {
  const state = new SparkState(statePath())
  const { accounts } = loadAddressBook(dbPath())
  console.log(renderMovements(classify(state, accounts)))
  state.close()
  process.exit(0)
}

// One-shot scan, for cron-style use.
if (process.argv[2] === 'track') {
  const result = await track(trackOpts())
  console.log(renderTrack(result))
  process.exit(0)
}

// Long-running: scan on an interval. This is the process that must stay up for
// movements to be captured at all.
if (process.argv[2] === 'watch') {
  const intervalMs = Number(process.env.SPARK_INTERVAL_MS ?? 5 * 60 * 1000)
  console.log(`Spark tracker watching every ${Math.round(intervalMs / 1000)}s`)
  // Deliberately not awaited: the HTTP surface below must come up alongside the
  // loop, and awaiting here would block module evaluation forever.
  void (async () => {
    for (;;) {
      try {
        console.log(renderTrack(await track(trackOpts())))
      } catch (err) {
        // Never exit the loop on error. A crash stops capture, and history that
        // goes uncaptured may not be re-fetchable later.
        console.error(`[${new Date().toISOString()}] track failed: ${(err as Error).message}`)
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  })()
}

if (process.argv[2] === 'verify') {
  const { Wallet } = await import('./wallet')
  const { chainById } = await import('./chains')
  const problems = await new Wallet('0x0000000000000000000000000000000000000000').verifyRegistry()
  if (!problems.length) console.log('Token registry verified: every entry matches its on-chain symbol.')
  for (const p of problems) {
    console.log(`  ! ${chainById(p.chainId)?.name ?? p.chainId} / ${p.symbol}: ${p.problem}`)
  }
  process.exit(problems.length ? 1 : 0)
}

if (process.argv[2] === 'defi') {
  const report = await buildDefiReport({ dbPath: dbPath() })
  console.log(renderDefiText(report))
  process.exit(report.alerts.length > 0 ? 1 : 0)
}

export default {
  // Every knob is SPARK_-prefixed so Spark's configuration is unambiguous in a
  // shared environment; PORT alone is too generic to own.
  port: Number(process.env.SPARK_PORT ?? 3000),
  fetch: app.fetch,
}
