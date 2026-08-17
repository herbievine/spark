/**
 * Aave V3, read from the Pool contract on every chain where it is deployed.
 *
 * `getUserAccountData` returns the whole position in one call, already priced by
 * Aave's own oracle in USD with 8 decimals, so no external price feed is needed.
 */

import { createPublicClient, http, formatUnits } from 'viem'
import { CHAINS, type Chain } from './chains'
import { Protocol, type Position, type ProtocolResult } from './protocol'

const POOL_ABI = [
  {
    name: 'getUserAccountData',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const

/** Positions below this USD value are not worth a row. */
const DUST_USD = 0.001

export class AaveV3 extends Protocol {
  readonly name = 'Aave V3'

  constructor(private readonly chains: Chain[] = CHAINS) {
    super()
  }

  async positions(address: string): Promise<ProtocolResult> {
    const positions: Position[] = []
    const errors: string[] = []

    await Promise.all(
      this.chains
        .filter((chain) => chain.aavePool)
        .map(async (chain) => {
          const client = createPublicClient({ transport: http(chain.rpc) })
          try {
            const result = await client.readContract({
              address: chain.aavePool!,
              abi: POOL_ABI,
              functionName: 'getUserAccountData',
              args: [address as `0x${string}`],
            })

            // Aave V3's base currency is USD with 8 decimals.
            const suppliedUsd = Number(formatUnits(result[0], 8))
            const borrowedUsd = Number(formatUnits(result[1], 8))
            if (suppliedUsd < DUST_USD && borrowedUsd < DUST_USD) return

            positions.push({
              protocol: this.name,
              chain: chain.name,
              suppliedUsd,
              borrowedUsd,
              netUsd: suppliedUsd - borrowedUsd,
            })
          } catch (err) {
            errors.push(`${this.name} on ${chain.name}: ${(err as Error).message.split('\n')[0]}`)
          }
        }),
    )

    positions.sort((a, b) => b.netUsd - a.netUsd)
    return { positions, errors, notes: [] }
  }
}
