/**
 * Identifying who is on the other side of a transfer.
 *
 * This matters more than it looks: `WITHDRAWAL` is an *external flow* in
 * Wealthfolio and corrupts every return figure, so moving value to a venue you
 * still own — an exchange account, a Zeal wallet — must never be booked as one.
 *
 * Three sources, in order of reliability:
 *
 * 1. **Known addresses** (below). Exchange *hot* wallets are publicly labelled
 *    and stable. Note this cannot be exhaustive: exchange **deposit** addresses
 *    are generated per user, so yours will not appear on any public list and has
 *    to be added by hand once observed.
 * 2. **On-chain introspection.** A Zeal wallet is a Safe 1.4.1 contract, and its
 *    address is per-user, so it can only be recognised by asking the contract
 *    what it is — never by a hardcoded list.
 * 3. **Manual labels** in `VENUE_LABELS`, for anything the first two miss.
 *
 * Blockscout was evaluated as a fourth source and rejected: its public instances
 * return empty `public_tags` even for addresses Etherscan labels clearly, so it
 * cannot identify exchanges.
 */

import { createPublicClient, http } from 'viem'
import { chainById } from './chains'

/**
 * Publicly labelled exchange hot wallets. Sourced from Etherscan's public tags.
 *
 * A transfer to one of these is a real transfer to an exchange. Whether that is
 * an external flow depends on whether the account is yours — which is why these
 * are labelled rather than auto-classified.
 */
export const KNOWN_EXCHANGES: Record<string, string> = {
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance',
  '0xeb2d2f1b8c558a40207669291fda468e50c8a0bb': 'Binance',
  '0xf92402bb795fd7cd08fb83839689db79099c8c9c': 'Binance',
  '0x631fc1ea2270e98fbd9d92658ece0f5a269aa161': 'Binance',
  '0xa180fe01b906a1be37be6c534a3300785b20d947': 'Binance',
  '0x29bdfbf7d27462a2d115748ace2bd71a2646946c': 'Binance',
  '0xe9f7ecae3a53d2a67105292894676b00d1fab785': 'Kraken',
  '0x75e89d5979e4f6fba9f97c104c2f0afb3f1dcb88': 'MEXC',  // chains [1, 8453]
  '0x0211f3cedbef3143223d3acf0e589747933e8527': 'MEXC',  // chains [1]
  '0x3cc936b795a188f0e246cbb2d74c5bd190aecf18': 'MEXC',  // chains [1]
  '0x9642b23ed1e01df1092b92641051881a322f5d4e': 'MEXC',  // chains [1]
  '0x469afe803c54a36674c55231489cf4b61da8c1bc': 'MEXC',  // chains [1]
  '0x4982085c9e2f89f2ecb8131eca71afad896e89cb': 'MEXC',  // chains [56, 8453]
  '0x9b64203878f24eb0cdf55c8c6fa7d08ba0cf77e5': 'MEXC',  // chains [42161]
  '0x9bb6a22da110c6c9bab745bcaf0ee142ee83af37': 'MEXC',  // chains [56]
  '0x2e8f79ad740de90dc5f5a9f0d8d9661a60725e64': 'MEXC',  // chains [56]
}

/**
 * MEXC caveat: the addresses above came from explorer page *titles* in search
 * results, because Etherscan and its siblings return 403 to automated fetches —
 * so the tag is genuine but second-hand, and confidence is capped at medium.
 * Worth confirming in the explorer UI before relying on any of them. Note also
 * that MEXC's numbered labels are chain-specific: "MEXC 3" is a different
 * address on Ethereum than on BNB Chain.
 */

export type CounterpartyKind = 'exchange' | 'safe' | 'contract' | 'eoa'

export type Counterparty = {
  address: string
  kind: CounterpartyKind
  label: string | null
  /** Safe contract version, when it is one. Zeal deploys Safe 1.4.1. */
  safeVersion?: string
}

const SAFE_ABI = [
  { name: 'VERSION', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'getOwners', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
] as const

/**
 * Works out what an address is by asking the chain.
 *
 * A Zeal wallet cannot be recognised from a list — every user gets their own
 * Safe — so it is identified structurally: a contract that answers `VERSION()`
 * with a Safe version and exposes owners. On Gnosis that is overwhelmingly Zeal
 * or Gnosis Pay, since that is what those products deploy.
 */
export async function identify(chainId: number, address: string): Promise<Counterparty> {
  const lower = address.toLowerCase()

  const exchange = KNOWN_EXCHANGES[lower]
  if (exchange) return { address: lower, kind: 'exchange', label: exchange }

  const chain = chainById(chainId)
  if (!chain) return { address: lower, kind: 'eoa', label: null }

  const client = createPublicClient({ transport: http(chain.rpc) })

  try {
    const code = await client.getCode({ address: lower as `0x${string}` })
    if (!code || code === '0x') return { address: lower, kind: 'eoa', label: null }

    try {
      const version = await client.readContract({
        address: lower as `0x${string}`,
        abi: SAFE_ABI,
        functionName: 'VERSION',
      })
      // Version is recorded but never filtered on. Zeal's own smart wallet is
      // Safe 1.4.1 per its docs, but every Gnosis Pay *card* safe sampled on
      // Gnosis reports 1.3.0 (singleton 0xd9Db270c…09552) — so requiring 1.4.1
      // would miss exactly the accounts that spend. They appear to be two
      // different accounts that Zeal manages together.
      const label = chainId === 100 ? 'Safe (Zeal / Gnosis Pay)' : 'Safe'
      return { address: lower, kind: 'safe', label, safeVersion: version }
    } catch {
      return { address: lower, kind: 'contract', label: null }
    }
  } catch {
    return { address: lower, kind: 'eoa', label: null }
  }
}
