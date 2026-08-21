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

/** Reserved cursor key holding the last scan *attempt* time, not a block. */
const ATTEMPT_KEY = '#scan-attempt'

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

  const nowSeconds = Math.floor(Date.now() / 1000)

  /**
   * Chains run concurrently; the accounts inside one chain do not.
   *
   * Each chain is a different host, so there is no shared budget to blow by
   * overlapping them — and run one at a time the whole scan costs the sum of
   * every chain's latency rather than the slowest one's. The accounts within a
   * chain stay sequential precisely because they *do* share a host: seven
   * simultaneous requests to one explorer is what earns a rate limit, and Base
   * already throttles hard enough to need a 30-minute floor.
   */
  const chainResults = await Promise.all(
    CHAINS.filter((chain) => chain.logRpc).map(async (chain) => {
      const chainErrors: string[] = []
      const chainScanned: TrackResult['scanned'] = []
      let chainNew = 0

      // Chains that throttle need a floor between scans. The attempt time is
      // kept in the cursor table under a reserved address, so a failed scan
      // still counts as an attempt — otherwise a throttled chain would be
      // retried every cycle, which is exactly what caused the throttling.
      if (chain.scanIntervalMs) {
        const lastAttempt = state.getCursor(chain.id, ATTEMPT_KEY)
        if (lastAttempt !== null && nowSeconds - lastAttempt < chain.scanIntervalMs / 1000) {
          return { errors: chainErrors, scanned: chainScanned, newTransfers: chainNew }
        }
        state.setCursor(chain.id, ATTEMPT_KEY, nowSeconds)
      }

      /**
       * Head resolved once per chain rather than once per account.
       *
       * It was previously re-fetched inside the account loop, which is one
       * redundant round trip per account per chain. Reading it before any
       * account is scanned also makes the cursor strictly conservative: it can
       * only lag the range actually covered, never lead it, so a transfer
       * landing mid-scan is re-read next run instead of being skipped.
       */
      let head: number | null = null
      if (chain.explorerApi) {
        try {
          head = await headBlock(chain)
        } catch (err) {
          chainErrors.push(`${chain.name} head: ${(err as Error).message}`)
          return { errors: chainErrors, scanned: chainScanned, newTransfers: chainNew }
        }
      }

      for (const account of addresses) {
        try {
          let from = state.getCursor(chain.id, account.address)
          if (from === null) {
            // First sight of this pair: start at the tracking epoch, not at
            // head, so the window since the epoch is not silently skipped.
            if (!epochBlock.has(chain.id)) epochBlock.set(chain.id, await blockAtTime(chain, TRACKING_START))
            from = epochBlock.get(chain.id)!
          }

          let added = 0

          // Where an explorer exists, one request returns the whole history —
          // vastly cheaper than paging logs, and it still catches CoW trades
          // because it is transfer-based rather than transaction-based.
          // A failed explorer call must not advance the cursor: doing so skips
          // the unscanned range forever, and the next run starts past the
          // transfers that were never captured.
          let tokenScanFailed = false
          if (chain.explorerApi) {
            const tokens = await ledger.scanTokenTransfers(chain, account.address, from)
            chainErrors.push(...tokens.errors)
            tokenScanFailed = tokens.errors.length > 0
            added += state.recordTransfers(tokens.transfers)
          }

          // Log paging is the fallback for chains with no explorer. Running it
          // as well on an explorer chain would re-derive the same transfers at
          // thousands of times the cost.
          const result = chain.explorerApi
            ? { transfers: [], scannedTo: head!, errors: [] }
            : await ledger.scan(chain, account.address, from, (rows, scannedTo) => {
                // Commit per chunk: transfers and the cursor advance together,
                // so an interrupted backfill resumes where it stopped rather
                // than restarting.
                added += state.recordTransfers(rows)
                state.setCursor(chain.id, account.address, scannedTo)
              })
          chainErrors.push(...result.errors)
          added += state.recordTransfers(result.transfers)
          chainNew += added

          if (result.scannedTo > from && !tokenScanFailed) {
            state.setCursor(chain.id, account.address, result.scannedTo)
          }

          if (added > 0 || result.scannedTo > from) {
            chainScanned.push({
              chain: chain.name,
              account: account.name,
              fromBlock: from,
              toBlock: result.scannedTo,
              found: added,
            })
          }
          // Native transfers and gas, which no log can show. Tracked on its own
          // cursor: it was added after log scanning had already advanced to
          // head, and sharing that cursor would skip every historical native
          // transfer.
          if (chain.explorerApi) {
            const nativeKey = `${account.address}#native`
            let nativeFrom = state.getCursor(chain.id, nativeKey)
            if (nativeFrom === null) {
              if (!epochBlock.has(chain.id)) epochBlock.set(chain.id, await blockAtTime(chain, TRACKING_START))
              nativeFrom = epochBlock.get(chain.id)!
            }
            const native = await ledger.scanNative(chain, account.address, nativeFrom)
            chainErrors.push(...native.errors)
            chainNew += state.recordTransfers(native.transfers)
            state.recordGas(native.gas)
            if (!native.errors.length) state.setCursor(chain.id, nativeKey, result.scannedTo)
          }
        } catch (err) {
          chainErrors.push(`${chain.name}/${account.name}: ${(err as Error).message}`)
        }
      }

      return { errors: chainErrors, scanned: chainScanned, newTransfers: chainNew }
    }),
  )

  // Merged in CHAINS order rather than completion order, so concurrency does not
  // make the output shuffle between runs.
  for (const r of chainResults) {
    errors.push(...r.errors)
    scanned.push(...r.scanned)
    newTransfers += r.newTransfers
  }

  // Balance snapshots: the only way native movement and gas become visible,
  // since neither emits a log. One account's balances span every chain, so
  // these overlap across hosts the same way the scans above do.
  const takenAt = new Date().toISOString()
  const snapshots = await Promise.all(
    addresses.map(async (account) => {
      try {
        const { balances, errors: balanceErrors } = await new Wallet(account.address as `0x${string}`).balances()
        return { account, balances, errors: balanceErrors.map((e) => `${account.name}: ${e}`) }
      } catch (err) {
        return {
          account,
          balances: [],
          errors: [`${account.name}: balance snapshot — ${(err as Error).message}`],
        }
      }
    }),
  )
  for (const snapshot of snapshots) {
    errors.push(...snapshot.errors)
    state.recordBalances(
      takenAt,
      snapshot.balances.map((b) => ({
        chainId: b.chainId,
        address: snapshot.account.address,
        symbol: b.symbol,
        quantity: String(b.quantity),
      })),
    )
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
