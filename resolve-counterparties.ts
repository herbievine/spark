/**
 * Name the counterparties, by asking each chain's explorer what the address is.
 *
 * Most "unknown" counterparties are not mysterious at all — they are verified
 * contracts with published names: GPv2Settlement is CoW Protocol, LiFiDiamond is
 * a bridge, PendleRouterV4 is Pendle. Flagging those alongside genuinely
 * unidentified addresses buries the handful that matter under hundreds that do
 * not, so they are resolved from the explorer rather than guessed from memory.
 *
 * What survives is the interesting set: addresses with no contract behind them
 * (a wallet — someone's, and worth knowing whose) and unverified contracts.
 *
 * Cached in .local/counterparty-names.json, so a rate limit costs only the
 * addresses not yet resolved and a re-run picks up where it stopped.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CHAINS } from './src/chains'

const CACHE = '.local/counterparty-names.json'
const cache: Record<string, { name: string | null; isContract: boolean }> = existsSync(CACHE)
  ? JSON.parse(readFileSync(CACHE, 'utf8'))
  : {}

/** Blockscout's v2 address endpoint, which carries the verified contract name. */
const V2: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  10: 'https://optimism.blockscout.com',
  100: 'https://gnosis.blockscout.com',
  137: 'https://polygon.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Falls back to the RPC: code at the address means a contract, absence means a wallet. */
async function isContract(chainId: number, address: string): Promise<boolean | null> {
  const chain = CHAINS.find((c) => c.id === chainId)
  if (!chain) return null
  try {
    const res = await fetch(chain.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      signal: AbortSignal.timeout(20000),
    })
    const body = (await res.json()) as any
    if (typeof body?.result !== 'string') return null
    return body.result !== '0x'
  } catch {
    return null
  }
}

export async function resolveNames(pairs: { address: string; chainId: number }[]): Promise<typeof cache> {
  let done = 0
  for (const { address, chainId } of pairs) {
    const key = address.toLowerCase()
    if (cache[key]) continue

    let name: string | null = null
    const host = V2[chainId]
    if (host) {
      try {
        const res = await fetch(`${host}/api/v2/addresses/${address}`, { signal: AbortSignal.timeout(25000) })
        if (res.ok) {
          const d = (await res.json()) as any
          name = d?.name ?? null
          if (!name && Array.isArray(d?.implementations) && d.implementations[0]?.name) {
            name = d.implementations[0].name
          }
        }
      } catch {
        // Leave it unresolved; a later run retries rather than recording a guess.
      }
    }

    const contract = await isContract(chainId, address)
    if (name !== null || contract !== null) {
      cache[key] = { name, isContract: contract ?? name !== null }
      done++
      if (done % 10 === 0) writeFileSync(CACHE, JSON.stringify(cache, null, 1))
    }
    await sleep(250)
  }
  writeFileSync(CACHE, JSON.stringify(cache, null, 1))
  return cache
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(process.argv[2] ?? '.local/unknown-input.json', 'utf8'))
  const out = await resolveNames(input)
  const named = Object.values(out).filter((v) => v.name).length
  const eoa = Object.values(out).filter((v) => !v.isContract).length
  console.log(`resolved ${Object.keys(out).length}: ${named} named contracts, ${eoa} plain wallets`)
}
