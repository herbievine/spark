/**
 * Re-resolve symbols on already-captured transfers.
 *
 * Symbols are recorded at capture time, so rows captured before a token was
 * registered — or before the explorer fallback existed — keep an
 * `UNKNOWN:0x…` stub. That is not a capture failure: the contract address was
 * stored, so the name can be recovered at any time without re-reading the chain.
 *
 * This is why capture and interpretation are separate. Re-fetching history is
 * bounded by what endpoints will still serve; re-reading a contract is not.
 */

import { createPublicClient, http, erc20Abi } from 'viem'
import { Database } from 'bun:sqlite'
import { CHAINS, TOKENS } from './chains'

export type ResolveResult = {
  contractsSeen: number
  contractsResolved: number
  rowsUpdated: number
  failures: string[]
}

export async function resolveSymbols(statePath: string): Promise<ResolveResult> {
  const db = new Database(statePath)
  // The tracker holds the write lock during a scan. Wait for it rather than
  // failing, so this can run against a live instance without stopping capture.
  db.exec('PRAGMA busy_timeout = 30000')
  const registry = new Map(TOKENS.map((t) => [`${t.chainId}:${t.address.toLowerCase()}`, t.symbol]))

  const pending = db
    .query<{ chain_id: number; contract: string; n: number }, []>(
      `SELECT chain_id, contract, COUNT(*) AS n
         FROM transfers
        WHERE symbol LIKE 'UNKNOWN:%' AND contract IS NOT NULL
        GROUP BY chain_id, contract`,
    )
    .all()

  const result: ResolveResult = {
    contractsSeen: pending.length,
    contractsResolved: 0,
    rowsUpdated: 0,
    failures: [],
  }

  const update = db.prepare('UPDATE transfers SET symbol = ? WHERE chain_id = ? AND contract = ?')

  for (const row of pending) {
    const chain = CHAINS.find((c) => c.id === row.chain_id)
    if (!chain) continue

    // The registry is authoritative when it knows the contract, since its
    // symbols are the ones Wealthfolio matches on.
    const known = registry.get(`${row.chain_id}:${row.contract}`)
    let symbol = known

    if (!symbol) {
      try {
        const onChain = await createPublicClient({ transport: http(chain.rpc) }).readContract({
          address: row.contract as `0x${string}`,
          abi: erc20Abi,
          functionName: 'symbol',
        })
        // Unvetted names keep the `?` marker: a hostile contract can claim any
        // ticker, so this is a hint for reading, never an identity to book on.
        if (onChain) symbol = `${String(onChain).slice(0, 12)}?`
      } catch (err) {
        result.failures.push(`${chain.name}/${row.contract.slice(0, 10)}: ${(err as Error).message.split('\n')[0]}`)
      }
    }

    if (symbol) {
      const res = update.run(symbol, row.chain_id, row.contract)
      result.contractsResolved++
      result.rowsUpdated += res.changes
    }
  }

  // Second pass: rows whose contract is in the registry but whose stored symbol
  // is not the registry's. A token registered *after* those rows were captured
  // keeps the unvetted `SYMBOL?` name it was given at the time, which splits one
  // holding across two symbols and leaves the vetted half looking like it lost
  // an inflow. Registering a contract has to reach the rows already stored.
  const misnamed = db
    .query<{ chain_id: number; contract: string; symbol: string }, []>(
      `SELECT DISTINCT chain_id, contract, symbol
         FROM transfers
        WHERE contract IS NOT NULL AND symbol NOT LIKE 'UNKNOWN:%'`,
    )
    .all()

  for (const row of misnamed) {
    const known = registry.get(`${row.chain_id}:${row.contract}`)
    if (!known || known === row.symbol) continue
    const res = db
      .prepare('UPDATE transfers SET symbol = ? WHERE chain_id = ? AND contract = ? AND symbol = ?')
      .run(known, row.chain_id, row.contract, row.symbol)
    result.rowsUpdated += res.changes
    result.contractsResolved++
  }

  db.close()
  return result
}
