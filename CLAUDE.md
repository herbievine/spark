# Working on Spark

Spark keeps Herbie's on-chain wallets and exchange accounts reconciled inside
self-hosted Wealthfolio. `NOTES.md` explains *why* the design is what it is and
is worth reading before changing anything structural. This file is the operating
manual: what to run, in what order, and which traps have already been paid for.

## The one-paragraph model

Capture is separated from interpretation. `track` writes raw transfers into
`spark.db` and its only job is to **miss nothing** — a transfer not captured soon
enough may become unfetchable, whereas classification can be re-run forever
against stored rows. Everything downstream (ledger, plan, import) is derived and
can be rebuilt at will. **Never delete `spark.db`.**

## Secrets and configuration

Nothing identifying belongs in this repository — it is **public**. Addresses,
extended public keys and tokens live outside it:

| What | Where |
|---|---|
| Wallet list, venue labels, `SPARK_BTC_ZPUB` | `.local/wallets.env` (gitignored) |
| Wealthfolio password | macOS Keychain, service `wealthfolio` |
| Wealthfolio agent token (MCP) | macOS Keychain, service `spark-wf-token` |

Load config with `. .local/wallets.env` at the start of any command that needs
wallets. `src/config.ts` reads `SPARK_WALLETS` (`name:venue:address,…`) and
`SPARK_VENUE_LABELS` (`address=label,…`).

```sh
. .local/wallets.env
export SPARK_WF_PASSWORD="$(security find-generic-password -a "$USER" -s wealthfolio -w)"
export SPARK_WF_TOKEN="$(security find-generic-password -a "$USER" -s spark-wf-token -w)"
export SPARK_WF_URL=https://<your-wealthfolio-host>
export SPARK_STATE_PATH=.local/spark.db
```

`SPARK_WF_DB_PATH` points at a **copy** of Wealthfolio's SQLite for the address
book. Point it at a nonexistent path to fall back to `SPARK_WALLETS` alone —
needed when scanning a wallet that has no Wealthfolio account yet.

## Common commands

```sh
bun run src/index.ts track              # scan every chain, capture new transfers
bun run src/index.ts ledger '' csv      # whole-history ledger ('' = all years)
bun run src/index.ts report             # holdings vs chain, per account
bun run src/index.ts verify             # assert every token registry entry is real
bun run src/index.ts resolve-symbols    # re-resolve symbols after editing the registry
bun run src/index.ts verify-transfers   # check explorer rows against receipts
bun run src/index.ts movements          # classified movements
```

Root scripts, in the order a full rebuild uses them:

| Script | Does |
|---|---|
| `fullplan.ts` | Builds `.local/full-plan.json` from the ledger and prints a reconciliation. **Must say `ALL MATCH` before importing.** |
| `wipe-activities.ts` | Deletes activities. `SPARK_WIPE_ACCOUNTS` selects accounts; dry run unless `SPARK_COMMIT=1`. |
| `importplan.ts` | Imports a plan file (`SPARK_PLAN_OUT`) via MCP. |
| `create-accounts.ts` | Creates missing Wealthfolio accounts, idempotent. |
| `venues.ts` | Normalises Coinbase/Binance/peer.xyz and matches each record to a chain transfer. |
| `import-venues.ts` | Books exchange records into their own accounts. |
| `scan-bitcoin.ts` / `import-bitcoin.ts` | Derives the BIP84 wallet from the zpub and books it. |
| `flag-unknown.ts` | Counterparties Spark cannot name, with explorer lookups. |
| `tax-2025.ts` | French capital-gains reconstruction (art. 150 VH bis). |

## Wealthfolio: two interfaces, and you need both

- **MCP** (`/mcp`, agent token) — reading, and `prepare_activity_import` /
  `commit_activity_import` for writing. **There is no delete tool.**
- **REST** (`/api/v1`, session cookie from `POST /auth/login` with the password)
  — the only way to delete. `POST /activities/bulk` takes
  `{creates, updates, deleteIds}`. `POST /activities/search` uses
  `accountIdFilter` and **0-based** `page`; the count is `meta.totalRowCount`.

Prefer the API over writing to Wealthfolio's database directly even when
permitted: a direct write bypasses the valuation engine, so holdings silently
stop matching the activities that produced them.

After importing, `POST /api/v1/portfolio/recalculate` (returns 202, async). **Holdings
lag activities** — if a balance looks stale, recalculate and wait before believing it.

## Traps already paid for

- **A throttled explorer answers HTTP 200 with `result` as a message string.**
  Read as "no transfers" this is silent, permanent loss. Non-array results are
  retried then surfaced; a failed scan must never advance a cursor.
- **Explorers invent rows.** Routescan attributed one transfer to two hashes;
  Base and Ethereum had phantoms too. `verify-transfers` matches every
  explorer-derived row against its receipt and deletes what the chain lacks.
- **Wealthfolio fingerprints duplicates on the calendar day.** Identical same-day
  rows must be merged before import or they are silently skipped — this ate 1,094
  of 3,601 venue rows once.
- **A disposal is clamped at zero, never negative.** If a plan's running balance
  dips below zero, the shortfall persists forever no matter how often you
  recalculate. `fullplan.ts` fills each dip and returns it after the last
  movement.
- **Symbols are traps.** `WETH` matches a NASDAQ company, `POL-USD` is Polkadot
  (use `MATIC-USD`), `ARB-USD` is "ARbit" (use `ARB11841-USD`), `CBBTC-USD` is an
  unrelated micro-cap. Verify every new symbol against the resolver before adding
  it to `WEALTHFOLIO_SYMBOLS`.
- **Gas leaves a wallet without emitting a transfer**, so native balances derived
  from transfers alone are always too high. `fullplan.ts` books it.
- **Some contracts mirror another's events.** Monerium's old EURe emits the same
  transfer as the new one and reports the same balance; `historic: true` keeps it
  for symbol resolution while excluding it from balances and the ledger.
- **Base's Blockscout throttles hard.** It has a 30-minute `scanIntervalMs`; the
  attempt time is recorded even on failure, or a throttled chain retries forever.

## Deployment

Runs on the server at `/srv/spark`, container `spark`, state in the
`spark_spark-state` volume.

```sh
rsync -az --delete --exclude '.env' --exclude '.local' --exclude 'ledger' \
      --exclude 'backups' --exclude 'node_modules' --exclude '.git' ./ <server>:/srv/spark/
ssh <server> 'cd /srv/spark && docker compose up -d --build'
ssh <server> 'docker logs --tail 40 spark'
```

If you fix data locally, **push the state database back**, or the server will
re-scan and reintroduce what you removed. Stop the container first.

## Before anything destructive

Back up. Herbie has asked for this repeatedly and it has saved the work more than
once.

```sh
scp "<server>:<wealthfolio-data-dir>/wealthfolio.db*" backups/<name>/
cp .local/spark.db backups/spark-<date>.db
```

`wipe-activities.ts` often needs several passes — the API returns fewer deletions
than requested. Re-run until it reports `total to delete: 0`.

## Conventions

- Refuse rather than guess. An unverified symbol or unknown price skips the row;
  a wrong asset is far more expensive to find later than a missing one is to add.
- Report gaps out loud. A known gap is worth more than a number that looks right.
- `ledger/` is gitignored — it holds addresses and financial history.
