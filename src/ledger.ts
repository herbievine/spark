/**
 * The transfer feed: ERC-20 `Transfer` logs involving a tracked address.
 *
 * Scans **logs**, not transaction lists, and that is a correctness requirement
 * rather than a convenience. CoW Protocol trades are submitted by a solver, so
 * the transaction's `from` is not the user — anything enumerating "my
 * transactions" misses those trades entirely. Logs catch them, because the token
 * still moves to and from the tracked address.
 *
 * Native-token movement emits no log and is therefore not captured here; it is
 * tracked by balance snapshot instead, where the daily unexplained decrease is
 * gas (including gas burned on approvals and failed transactions, which have no
 * log either).
 */

import { createPublicClient, http, erc20Abi, type PublicClient } from 'viem'
import { CHAINS, TOKENS, type Chain } from './chains'
import type { TransferRow } from './state'

/** keccak256('Transfer(address,address,uint256)') */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Blocks to stay behind head before a transfer is considered settled. A reorg
 * that unwinds a booked activity is far more expensive to repair than a few
 * minutes of latency is to tolerate.
 */
const CONFIRMATIONS = 12

/**
 * Pause between chunk requests. Free endpoints rate-limit by IP — a backfill run
 * flat out earned "your IP has exceeded its requests per second capacity" from
 * Optimism. Pacing costs minutes on the initial backfill and nothing thereafter,
 * since routine runs scan only a handful of chunks.
 */
const PACE_MS = 120

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const pad = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`

export type ScanResult = {
  transfers: TransferRow[]
  /** Where the cursor should land: the last block actually scanned. */
  scannedTo: number
  errors: string[]
}

type RpcLog = {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  logIndex: string
}

/**
 * One retry with a pause before giving up on a request.
 *
 * Free endpoints fail transiently as a matter of course — "temporary internal
 * error", "no backend is currently healthy", per-second rate limits. Without a
 * retry each one stalls that chain's cursor for a whole cycle, which on a chain
 * paged in 2,000-block chunks means the backfill barely advances.
 */
async function rpc(url: string, method: string, params: unknown[], attempt = 0): Promise<any> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const body = await res.json()
    if (body.error) throw new Error(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
    return body.result
  } catch (err) {
    if (attempt >= 1) throw err
    await sleep(2500)
    return rpc(url, method, params, attempt + 1)
  }
}

/** Current head block for a chain. */
export async function headBlock(chain: Chain): Promise<number> {
  return Number(await rpc(chain.logRpc ?? chain.rpc, 'eth_blockNumber', []))
}

/** Resolves the block closest to a timestamp, by binary search over block headers. */
/**
 * `fetch` with a deadline.
 *
 * An explorer that accepts the connection and then never answers would otherwise
 * hang the whole tracking loop indefinitely — one slow host stalling every chain
 * behind it. A timeout surfaces as an error, which leaves the cursor where it is
 * and retries on the next run, so the range is deferred rather than skipped.
 */
async function fetchWithTimeout(url: string, ms = 60000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(ms) })
}

export async function blockAtTime(chain: Chain, unixSeconds: number): Promise<number> {
  const url = chain.logRpc ?? chain.rpc
  const head = Number(await rpc(url, 'eth_blockNumber', []))
  let lo = 1
  let hi = head
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const block = await rpc(url, 'eth_getBlockByNumber', [`0x${mid.toString(16)}`, false])
    if (!block) {
      lo = mid + 1
      continue
    }
    if (Number(block.timestamp) < unixSeconds) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class Ledger {
  private readonly decimalsCache = new Map<string, number>()
  private readonly unregisteredSymbols = new Map<string, string>()
  private readonly symbolByContract: Map<string, { symbol: string; chainId: number }>

  constructor(private readonly chains: Chain[] = CHAINS) {
    this.symbolByContract = new Map(
      TOKENS.map((t) => [`${t.chainId}:${t.address.toLowerCase()}`, { symbol: t.symbol, chainId: t.chainId }]),
    )
  }

  private client(chain: Chain): PublicClient {
    return createPublicClient({ transport: http(chain.rpc) }) as PublicClient
  }

  private async decimalsOf(chain: Chain, contract: string): Promise<number> {
    const key = `${chain.id}:${contract}`
    const cached = this.decimalsCache.get(key)
    if (cached !== undefined) return cached
    const value = await this.client(chain).readContract({
      address: contract as `0x${string}`,
      abi: erc20Abi,
      functionName: 'decimals',
    })
    this.decimalsCache.set(key, value)
    return value
  }

  /**
   * Scans one chain for transfers touching `address`, from `fromBlock` up to
   * head minus confirmations. Pages within the endpoint's block-range cap.
   */
  async scan(
    chain: Chain,
    address: string,
    fromBlock: number,
    /**
     * Called after each chunk so the caller can persist progress. Backfilling
     * from the tracking epoch can take thousands of requests; without
     * incremental commits a restart would redo all of it, and a crash near the
     * end would lose everything scanned.
     */
    onChunk?: (rows: TransferRow[], scannedTo: number) => void,
  ): Promise<ScanResult> {
    const errors: string[] = []
    if (!chain.logRpc) {
      return { transfers: [], scannedTo: fromBlock, errors: [`${chain.name}: no log-capable RPC configured`] }
    }

    const url = chain.logRpc
    const chunk = chain.logChunk ?? 9000
    const pace = chain.logPaceMs ?? PACE_MS
    const head = Number(await rpc(url, 'eth_blockNumber', []))
    const target = head - CONFIRMATIONS
    if (target <= fromBlock) return { transfers: [], scannedTo: fromBlock, errors }

    const found = new Map<string, RpcLog>()
    let cursor = fromBlock
    let scannedTo = fromBlock

    while (cursor < target) {
      const to = Math.min(cursor + chunk, target)
      // Two queries: the address as sender, and as recipient. Cheaper and far
      // more portable than fetching every Transfer and filtering client-side —
      // several endpoints refuse unfiltered queries outright.
      for (const topics of [
        [TRANSFER_TOPIC, pad(address), null],
        [TRANSFER_TOPIC, null, pad(address)],
      ]) {
        try {
          const logs: RpcLog[] = await rpc(url, 'eth_getLogs', [
            { fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics },
          ])
          for (const log of logs) found.set(`${log.transactionHash}:${log.logIndex}`, log)
        } catch (err) {
          // Report and stop advancing: a silently skipped range is a movement
          // lost for good, since the endpoint will not serve it indefinitely.
          errors.push(`${chain.name} ${cursor}-${to}: ${(err as Error).message}`)
          return { transfers: await this.decode(chain, [...found.values()]), scannedTo, errors }
        }
      }
      if (onChunk) {
        const decoded = await this.decode(chain, [...found.values()])
        onChunk(decoded, to)
        found.clear()
      }
      scannedTo = to
      cursor = to + 1
      await sleep(pace)
    }

    return { transfers: await this.decode(chain, [...found.values()]), scannedTo, errors }
  }

  /**
   * Native-token transfers and gas, from the chain's explorer API.
   *
   * Native value moves without emitting any event, so log scanning is blind to
   * it — a plain ETH send between two of your own wallets is invisible. There is
   * also no RPC method that lists an address's transactions, so an explorer is
   * the only free source for this.
   *
   * Native rows are stored with `logIndex: -1`, which cannot collide with a real
   * log index and keeps the same chainId:txHash:logIndex identity.
   */
  async scanNative(
    chain: Chain,
    address: string,
    fromBlock: number,
  ): Promise<{ transfers: TransferRow[]; gas: { chainId: number; txHash: string; address: string; blockTime: number; wei: string }[]; errors: string[] }> {
    if (!chain.explorerApi) return { transfers: [], gas: [], errors: [] }

    const url =
      `${chain.explorerApi}?module=account&action=txlist&address=${address}` +
      `&startblock=${fromBlock}&sort=desc`

    try {
      // Same throttling trap as `scanTokenTransfers`: a string `result` means
      // the explorer refused, not that the address has no native transfers.
      let rows: any[] | null = null
      let lastMessage = ''
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * attempt))
        const res = await fetchWithTimeout(url)
        const body = (await res.json()) as { result?: any; message?: string }
        if (Array.isArray(body.result)) {
          rows = body.result
          break
        }
        lastMessage = String(body.result ?? body.message ?? `HTTP ${res.status}`)
        if (/no transactions found/i.test(lastMessage)) {
          rows = []
          break
        }
      }
      if (rows === null) {
        return { transfers: [], gas: [], errors: [`${chain.name} native ${address}: ${lastMessage}`] }
      }

      const transfers: TransferRow[] = []
      const gas: { chainId: number; txHash: string; address: string; blockTime: number; wei: string }[] = []

      for (const t of rows) {
        const blockTime = Number(t.timeStamp)
        const value = BigInt(t.value ?? '0')

        if (value > 0n) {
          transfers.push({
            chainId: chain.id,
            txHash: t.hash,
            logIndex: -1,
            blockNumber: Number(t.blockNumber),
            blockTime,
            contract: null,
            symbol: chain.native,
            fromAddr: t.from,
            toAddr: t.to ?? '0x',
            rawValue: value.toString(),
            decimals: 18,
          })
        }

        // Gas is only paid by the sender, and is real even when the transaction
        // failed or moved nothing (an approval, for instance).
        if (String(t.from).toLowerCase() === address.toLowerCase()) {
          const wei = BigInt(t.gasUsed ?? '0') * BigInt(t.gasPrice ?? '0')
          if (wei > 0n) gas.push({ chainId: chain.id, txHash: t.hash, address, blockTime, wei: wei.toString() })
        }
      }

      return { transfers, gas, errors: [] }
    } catch (err) {
      return { transfers: [], gas: [], errors: [`${chain.name} native scan: ${(err as Error).message}`] }
    }
  }

  /**
   * Token transfers from the explorer's `tokentx`, which returns an address's
   * whole history in a single request.
   *
   * This supersedes `eth_getLogs` for backfill. Paging logs is bounded by the
   * endpoint's block-range cap, not by how much actually happened: a year of
   * Arbitrum is ~95M blocks, so at 9,000 per request it costs ~21,000 requests
   * **per address** to find a handful of transfers. Measured: 11.5 hours covered
   * two chains. The same history came back in one request here.
   *
   * Crucially this is **transfer**-based, not transaction-based, so it still
   * catches CoW Protocol trades where a solver submits the transaction and the
   * user is not `tx.from` — verified against a real CoW fill. That distinction
   * is why `txlist` cannot be used for this and `tokentx` can.
   */
  async scanTokenTransfers(
    chain: Chain,
    address: string,
    fromBlock: number,
  ): Promise<{ transfers: TransferRow[]; errors: string[] }> {
    if (!chain.explorerApi) return { transfers: [], errors: [] }

    try {
      const url = `${chain.explorerApi}?module=account&action=tokentx&address=${address}&startblock=${fromBlock}&sort=asc`

      // A throttled explorer answers 200 with `result` as a *message string*.
      // Reading that as "no transfers" and advancing the cursor past it is
      // silent, permanent data loss, so a non-array result is retried and then
      // reported as an error rather than mistaken for an empty history.
      let rows: any[] | null = null
      let lastMessage = ''
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * attempt))
        const res = await fetchWithTimeout(url)
        const body = (await res.json()) as { result?: any; message?: string }
        if (Array.isArray(body.result)) {
          rows = body.result
          break
        }
        lastMessage = String(body.result ?? body.message ?? `HTTP ${res.status}`)
        // "No transactions found" is a real, empty answer — not a failure.
        if (/no transactions found|no token transfers found/i.test(lastMessage)) {
          rows = []
          break
        }
      }
      if (rows === null) {
        return { transfers: [], errors: [`${chain.name} tokentx ${address}: ${lastMessage}`] }
      }

      // The explorer does not return `logIndex`. Defaulting it to 0 made every
      // leg of a transaction share the primary key (chain, tx, logIndex), so
      // INSERT OR IGNORE silently kept only the first — losing the other side of
      // every wrap, swap and multi-leg transfer. Positions within the (stable,
      // ascending) response give each leg a distinct synthetic index; negatives
      // keep them clear of real log indices and of the native marker (-1).
      const seqByTx = new Map<string, number>()

      return {
        transfers: rows.map((t: any) => ({
          chainId: chain.id,
          txHash: t.hash,
          logIndex:
            t.logIndex !== undefined && t.logIndex !== null
              ? Number(t.logIndex)
              : -(100 + (seqByTx.set(t.hash, (seqByTx.get(t.hash) ?? 0) + 1).get(t.hash)! - 1)),
          blockNumber: Number(t.blockNumber),
          blockTime: Number(t.timeStamp),
          contract: String(t.contractAddress).toLowerCase(),
          // The registry wins when it knows the token, because its symbols match
          // Wealthfolio's naming. Otherwise fall back to the explorer's symbol,
          // which is far more useful than a bare contract address — but mark it
          // `?` so an unregistered token is never mistaken for a vetted one. A
          // hostile contract can call itself anything, including a homoglyph of
          // a real ticker, so an unvetted name is a hint and not an identity.
          symbol:
            this.symbolByContract.get(`${chain.id}:${String(t.contractAddress).toLowerCase()}`)?.symbol ??
            (t.tokenSymbol ? `${String(t.tokenSymbol).slice(0, 12)}?` : `UNKNOWN:${String(t.contractAddress).slice(0, 10)}`),
          fromAddr: t.from,
          toAddr: t.to,
          rawValue: String(t.value),
          decimals: Number(t.tokenDecimal ?? 18),
        })),
        errors: [],
      }
    } catch (err) {
      return { transfers: [], errors: [`${chain.name} tokentx: ${(err as Error).message}`] }
    }
  }

  /**
   * Symbol for an unregistered contract, read from the contract itself.
   *
   * The explorer path gets symbols for free; the log path does not, and a wall of
   * `UNKNOWN:0x…` hides whether a row is real. The name is untrusted — a hostile
   * contract can claim any ticker — so it is suffixed `?` and the spam and
   * homoglyph filters still apply.
   */
  private async symbolOf(chain: Chain, contract: string): Promise<string> {
    const known = this.symbolByContract.get(`${chain.id}:${contract}`)
    if (known) return known.symbol
    const cached = this.unregisteredSymbols.get(`${chain.id}:${contract}`)
    if (cached !== undefined) return cached

    let result = `UNKNOWN:${contract.slice(0, 10)}`
    try {
      const sym = await this.client(chain).readContract({
        address: contract as `0x${string}`,
        abi: erc20Abi,
        functionName: 'symbol',
      })
      if (sym) result = `${String(sym).slice(0, 12)}?`
    } catch {
      // Non-standard or non-existent token; the address stub is the honest answer.
    }
    this.unregisteredSymbols.set(`${chain.id}:${contract}`, result)
    return result
  }

  private async decode(chain: Chain, logs: RpcLog[]): Promise<TransferRow[]> {
    const blockTimes = new Map<string, number>()
    const rows: TransferRow[] = []

    for (const log of logs) {
      // Transfer has exactly 3 topics; anything else is a different event that
      // happens to share the signature hash prefix.
      if (log.topics.length !== 3) continue

      let blockTime = blockTimes.get(log.blockNumber)
      if (blockTime === undefined) {
        const block = await rpc(chain.logRpc!, 'eth_getBlockByNumber', [log.blockNumber, false])
        blockTime = Number(block?.timestamp ?? 0)
        blockTimes.set(log.blockNumber, blockTime)
      }

      const contract = log.address.toLowerCase()
      const known = this.symbolByContract.get(`${chain.id}:${contract}`)
      let decimals = 18
      try {
        decimals = await this.decimalsOf(chain, contract)
      } catch {
        // Non-standard token; 18 is the safe default and the raw value is kept
        // verbatim so it can be re-scaled later without refetching.
      }

      rows.push({
        chainId: chain.id,
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        blockNumber: Number(log.blockNumber),
        blockTime,
        contract,
        // An unregistered contract is recorded, not dropped — it must surface as
        // an alert rather than vanish, since the API cannot create assets for it.
        symbol: known?.symbol ?? (await this.symbolOf(chain, contract)),
        fromAddr: `0x${log.topics[1]!.slice(26)}`,
        toAddr: `0x${log.topics[2]!.slice(26)}`,
        rawValue: BigInt(log.data === '0x' ? '0x0' : log.data).toString(),
        decimals,
      })
    }

    return rows
  }
}
