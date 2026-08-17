/**
 * The tracking loop: advance every cursor, capture what moved, snapshot balances.
 *
 * Capture is separated from interpretation on purpose. Classifying a transfer
 * (internal move, swap leg, bridge leg, external flow) can be improved and re-run
 * at any time against stored rows — but the rows themselves cannot be re-fetched
 * once endpoints stop serving that block range. So this job's single
 * responsibility is to miss nothing.
 */

import { loadAddressBook } from './address-book'
import { CHAINS } from './chains'
import { Ledger, blockAtTime, headBlock } from './ledger'
import { SparkState } from './state'
import { Wallet } from './wallet'

/**
 * Movements are tracked from this instant onward.
 *
 * Overridable with `SPARK_TRACKING_START` (an ISO date) so a narrow window can
 * be scanned while iterating — a full year across every chain takes long enough
 * that waiting for it to test a classification change is wasteful.
 */
export const TRACKING_START = process.env.SPARK_TRACKING_START
  ? Date.parse(process.env.SPARK_TRACKING_START) / 1000
  : Date.UTC(2026, 0, 1) / 1000

export type TrackResult = {
  startedAt: string
  newTransfers: number
  scanned: { chain: string; account: string; fromBlock: number; toBlock: number; found: number }[]
  errors: string[]
}

export async function track(opts: { dbPath: string; statePath: string }): Promise<TrackResult> {
  const { accounts, issues } = loadAddressBook(opts.dbPath)
  const state = new SparkState(opts.statePath)
  const ledger = new Ledger()
  const startedAt = state.startRun()

  // An address the book could not resolve is an address that is never scanned.
  // Reporting it as an error is the difference between a known gap and a wallet
  // that silently stops being tracked after a rename in Wealthfolio.
  const errors: string[] = issues.map((i) => `address book — ${i.account}: ${i.problem}`)
  const scanned: TrackResult['scanned'] = []
  let newTransfers = 0
  /** Start block per chain, resolved once — the search costs ~26 requests. */
  const epochBlock = new Map<number, number>()

  // Hyperliquid is a venue with its own API, not an address to scan for logs.
  const addresses = accounts.filter((a) => a.venue !== 'hyperliquid')

  for (const chain of CHAINS) {
    if (!chain.logRpc) continue

    for (const account of addresses) {
      try {
        let from = state.getCursor(chain.id, account.address)
        if (from === null) {
          // First sight of this pair: start at the tracking epoch, not at head,
          // so the window since 1 August is not silently skipped.
          if (!epochBlock.has(chain.id)) epochBlock.set(chain.id, await blockAtTime(chain, TRACKING_START))
          from = epochBlock.get(chain.id)!
        }

        let added = 0

        // Where an explorer exists, one request returns the whole history —
        // vastly cheaper than paging logs, and it still catches CoW trades
        // because it is transfer-based rather than transaction-based.
        // A failed explorer call must not advance the cursor: doing so skips the
        // unscanned range forever, and the next run starts past the transfers
        // that were never captured.
        let tokenScanFailed = false
        if (chain.explorerApi) {
          const tokens = await ledger.scanTokenTransfers(chain, account.address, from)
          errors.push(...tokens.errors)
          tokenScanFailed = tokens.errors.length > 0
          added += state.recordTransfers(tokens.transfers)
        }

        // Log paging is the fallback for chains with no explorer. Running it as
        // well on an explorer chain would re-derive the same transfers at
        // thousands of times the cost.
        const result = chain.explorerApi
          ? { transfers: [], scannedTo: await headBlock(chain), errors: [] }
          : await ledger.scan(chain, account.address, from, (rows, scannedTo) => {
          // Commit per chunk: transfers and the cursor advance together, so an
          // interrupted backfill resumes where it stopped rather than restarting.
              added += state.recordTransfers(rows)
              state.setCursor(chain.id, account.address, scannedTo)
            })
        errors.push(...result.errors)
        added += state.recordTransfers(result.transfers)
        newTransfers += added

        if (result.scannedTo > from && !tokenScanFailed) {
          state.setCursor(chain.id, account.address, result.scannedTo)
        }

        if (added > 0 || result.scannedTo > from) {
          scanned.push({
            chain: chain.name,
            account: account.name,
            fromBlock: from,
            toBlock: result.scannedTo,
            found: added,
          })
        }
        // Native transfers and gas, which no log can show. Tracked on its own
        // cursor: it was added after log scanning had already advanced to head,
        // and sharing that cursor would skip every historical native transfer.
        if (chain.explorerApi) {
          const nativeKey = `${account.address}#native`
          let nativeFrom = state.getCursor(chain.id, nativeKey)
          if (nativeFrom === null) {
            if (!epochBlock.has(chain.id)) epochBlock.set(chain.id, await blockAtTime(chain, TRACKING_START))
            nativeFrom = epochBlock.get(chain.id)!
          }
          const native = await ledger.scanNative(chain, account.address, nativeFrom)
          errors.push(...native.errors)
          newTransfers += state.recordTransfers(native.transfers)
          state.recordGas(native.gas)
          if (!native.errors.length) state.setCursor(chain.id, nativeKey, result.scannedTo)
        }
      } catch (err) {
        errors.push(`${chain.name}/${account.name}: ${(err as Error).message}`)
      }
    }
  }

  // Balance snapshots: the only way native movement and gas become visible,
  // since neither emits a log.
  const takenAt = new Date().toISOString()
  for (const account of addresses) {
    try {
      const { balances, errors: balanceErrors } = await new Wallet(account.address as `0x${string}`).balances()
      errors.push(...balanceErrors.map((e) => `${account.name}: ${e}`))
      state.recordBalances(
        takenAt,
        balances.map((b) => ({
          chainId: b.chainId,
          address: account.address,
          symbol: b.symbol,
          quantity: String(b.quantity),
        })),
      )
    } catch (err) {
      errors.push(`${account.name}: balance snapshot — ${(err as Error).message}`)
    }
  }

  state.finishRun(startedAt, newTransfers, errors.length ? `${errors.length} error(s)` : undefined)
  const stats = state.stats()
  state.close()

  return {
    startedAt,
    newTransfers,
    scanned,
    errors: errors.concat(
      stats.transfers === 0 && !errors.length ? ['no transfers captured yet — cursors are now armed'] : [],
    ),
  }
}

export function renderTrack(result: TrackResult): string {
  const out = [`Spark tracker — ${result.startedAt}`, '']
  if (result.scanned.length) {
    for (const s of result.scanned) {
      out.push(`  ${s.chain.padEnd(10)} ${s.account.padEnd(16)} blocks ${s.fromBlock}..${s.toBlock}  +${s.found}`)
    }
  } else {
    out.push('  nothing to scan')
  }
  out.push('', `New transfers captured: ${result.newTransfers}`)
  if (result.errors.length) {
    out.push('', 'ERRORS')
    for (const e of result.errors) out.push(`  ! ${e}`)
  }
  return out.join('\n')
}
