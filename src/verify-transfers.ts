/**
 * Check explorer-derived transfers against the chain, and repair them.
 *
 * Explorers that serve an Etherscan-shaped `tokentx` do not return a log index,
 * so those rows carry a synthetic one and are trusted on the explorer's word.
 * Routescan turned out not to deserve that trust: it attributed the same
 * transfer to two different transaction hashes, and only one of them contains it.
 * The phantom row inflates the balance and makes a position look unreconciled
 * for a movement that never happened.
 *
 * The receipt is the authority. Every stored row is matched against the real
 * `Transfer` logs of its transaction: a match takes the real log index, and
 * anything with no match is deleted, because it is not on the chain.
 */

import { Database } from 'bun:sqlite'
import { CHAINS } from './chains'

/** keccak256('Transfer(address,address,uint256)') */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export type VerifyResult = {
  transactions: number
  matched: number
  reindexed: number
  deleted: number
  errors: string[]
}

type Row = {
  chain_id: number
  tx_hash: string
  log_index: number
  contract: string | null
  from_addr: string
  to_addr: string
  raw_value: string
}

const addressOf = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase()

async function receiptLogs(rpcUrl: string, txHash: string): Promise<{ contract: string; from: string; to: string; value: bigint; logIndex: number }[] | null> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
    signal: AbortSignal.timeout(30000),
  })
  const body = ((await res.json().catch(() => null)) ?? {}) as any
  if (!body.result) return null
  return (body.result.logs ?? [])
    .filter((l: any) => l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3)
    .map((l: any) => ({
      contract: String(l.address).toLowerCase(),
      from: addressOf(l.topics[1]),
      to: addressOf(l.topics[2]),
      value: BigInt(l.data === '0x' ? '0x0' : l.data),
      logIndex: Number(l.logIndex),
    }))
}

/**
 * Verifies every synthetic-index row on `chainIds`. Native rows (log index -1)
 * are left alone: they come from the transaction list, not from a log, so there
 * is no log to match them against.
 */
export async function verifyTransfers(statePath: string, chainIds: number[]): Promise<VerifyResult> {
  const db = new Database(statePath)
  db.exec('PRAGMA busy_timeout = 30000')

  const result: VerifyResult = { transactions: 0, matched: 0, reindexed: 0, deleted: 0, errors: [] }

  for (const chainId of chainIds) {
    const chain = CHAINS.find((c) => c.id === chainId)
    if (!chain) continue
    // Prefer the log endpoint: receipts for old blocks need an archive node, and
    // several of the plain `rpc` hosts are pruned — they answer "not found" for a
    // transaction that exists, which would look exactly like a phantom row.
    const rpcUrl = chain.logRpc ?? chain.rpc

    const txs = db
      .query<{ tx_hash: string }, [number]>(
        'SELECT DISTINCT tx_hash FROM transfers WHERE chain_id = ? AND log_index <= -100',
      )
      .all(chainId)

    for (const { tx_hash } of txs) {
      result.transactions++
      let logs
      try {
        logs = await receiptLogs(rpcUrl, tx_hash)
      } catch (err) {
        result.errors.push(`${chain.name} ${tx_hash.slice(0, 12)}: ${(err as Error).message}`)
        continue
      }
      // No receipt means the node could not answer, not that the transfer is
      // fake. Leaving the rows alone is the safe direction.
      if (!logs) {
        result.errors.push(`${chain.name} ${tx_hash.slice(0, 12)}: no receipt`)
        continue
      }

      const rows = db
        .query<Row, [number, string]>(
          'SELECT chain_id, tx_hash, log_index, contract, from_addr, to_addr, raw_value FROM transfers WHERE chain_id = ? AND tx_hash = ? AND log_index <= -100',
        )
        .all(chainId, tx_hash)

      const claimed = new Set<number>()
      for (const row of rows) {
        const match = logs.find(
          (l) =>
            !claimed.has(l.logIndex) &&
            l.contract === (row.contract ?? '').toLowerCase() &&
            l.from === row.from_addr.toLowerCase() &&
            l.to === row.to_addr.toLowerCase() &&
            l.value === BigInt(row.raw_value),
        )

        if (!match) {
          db.prepare('DELETE FROM transfers WHERE chain_id = ? AND tx_hash = ? AND log_index = ?').run(
            row.chain_id,
            row.tx_hash,
            row.log_index,
          )
          result.deleted++
          continue
        }

        claimed.add(match.logIndex)
        result.matched++
        if (match.logIndex !== row.log_index) {
          // Move it onto its real identity, so a later re-scan of the same
          // transfer collides with it instead of inserting a second copy.
          db.prepare(
            'UPDATE OR REPLACE transfers SET log_index = ? WHERE chain_id = ? AND tx_hash = ? AND log_index = ?',
          ).run(match.logIndex, row.chain_id, row.tx_hash, row.log_index)
          result.reindexed++
        }
      }
    }
  }

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
  return result
}
