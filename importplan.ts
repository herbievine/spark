/**
 * Import a plan into Wealthfolio through the activity-import wizard.
 *
 * Two phases, deliberately: `prepare_activity_import` validates every row and
 * flags duplicates without writing anything, and only a second run with
 * `SPARK_COMMIT=1` calls `commit_activity_import`. A dry run is the only way to
 * see what an import will do before it has done it, and this import replaces a
 * year of history rather than appending a row.
 *
 * Duplicates are reported, never forced. Wealthfolio fingerprints duplicates on
 * the calendar day, so a row it calls a duplicate is one an earlier import
 * already booked — forcing it would double the position.
 */

import { readFileSync } from 'node:fs'
import { Wealthfolio } from './src/wealthfolio'

const PLAN = process.env.SPARK_PLAN_OUT ?? '.local/full-plan.json'
const COMMIT = process.env.SPARK_COMMIT === '1'
const BATCH = 100

const plan: any[] = JSON.parse(readFileSync(PLAN, 'utf8'))
if (!plan.length) {
  console.error(`${PLAN} is empty`)
  process.exit(1)
}

const wf = new Wealthfolio(process.env.SPARK_WF_URL!, process.env.SPARK_WF_TOKEN!)
await wf.connect()

let valid = 0
let invalid = 0
let duplicate = 0
const problems: string[] = []

for (let i = 0; i < plan.length; i += BATCH) {
  const slice = plan.slice(i, i + BATCH).map((r, n) => ({ ...r, lineNumber: i + n + 1 }))
  const res = await wf.tool<any>('prepare_activity_import', { activities: slice })
  const rows: any[] = res.rows ?? res.activities ?? res.results ?? []

  for (const r of rows) {
    const isDup = r.isDuplicate ?? r.duplicate ?? false
    const isValid = r.isValid ?? r.valid ?? true
    if (isDup) duplicate++
    else if (isValid) valid++
    else {
      invalid++
      problems.push(`line ${r.lineNumber}: ${JSON.stringify(r.errors ?? r.error ?? r)}`)
    }
  }

  if (COMMIT) {
    // Only rows that are neither invalid nor duplicates are committed.
    const toCommit = slice.filter((_, n) => {
      const r = rows[n]
      if (!r) return false
      return !(r.isDuplicate ?? r.duplicate ?? false) && (r.isValid ?? r.valid ?? true)
    })
    if (toCommit.length) {
      const done = await wf.tool<any>('commit_activity_import', { activities: toCommit })
      console.log(`committed ${toCommit.length}: ${JSON.stringify(done).slice(0, 300)}`)
    }
  }

  console.log(`batch ${i / BATCH + 1}: ${rows.length} rows checked`)
}

console.log()
console.log(`valid (would import) ${valid}`)
console.log(`duplicates (skipped) ${duplicate}`)
console.log(`invalid              ${invalid}`)
for (const p of problems.slice(0, 30)) console.log(`  ! ${p}`)
console.log(COMMIT ? '\nCOMMITTED' : '\nDRY RUN — set SPARK_COMMIT=1 to write')
