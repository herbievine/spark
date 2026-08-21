/**
 * A wallet: what one address holds directly, as quantities.
 *
 * Deliberately quantities and not values. Job A reconciles against Wealthfolio's
 * holdings, which are quantities, and introducing a price feed here would let
 * Spark disagree with Wealthfolio's own market data — reporting drift it created
 * itself. Valuation belongs to Protocol, where the protocol supplies the price.
 */

import { createPublicClient, http, erc20Abi, formatUnits, type PublicClient } from 'viem'
import { CHAINS, TOKENS, type Chain } from './chains'

export type TokenBalance = {
  chain: string
  chainId: number
  symbol: string
  /** null for the chain's native token. */
  contract: string | null
  quantity: number
  /** Airdropped spam; excluded from the drift report by default. */
  dust: boolean
}

export type RegistryProblem = { chainId: number; symbol: string; problem: string }

/**
 * `decimals()` per token, remembered for the life of the process.
 *
 * ERC-20 decimals is immutable — the standard gives it no setter — yet it was
 * being read alongside every balance, which is one wasted round trip per token
 * per address on every scan: sixty registered tokens across seven wallets is
 * 420 calls to learn sixty constants. The whole balance phase was 22 of the
 * scan's 39 seconds.
 *
 * The *promise* is cached rather than the value, so the seven addresses that
 * start at once share one in-flight request instead of racing to make seven.
 * A rejection is evicted, so a transient RPC failure is retried next scan
 * rather than poisoning the entry until restart.
 */
const decimalsCache = new Map<string, Promise<number>>()

function tokenDecimals(client: PublicClient, token: { chainId: number; address: `0x${string}` }): Promise<number> {
  const key = `${token.chainId}:${token.address.toLowerCase()}`
  let pending = decimalsCache.get(key)
  if (!pending) {
    pending = client
      .readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' })
      .catch((err) => {
        decimalsCache.delete(key)
        throw err
      })
    decimalsCache.set(key, pending)
  }
  return pending
}

export class Wallet {
  private readonly clients = new Map<number, PublicClient>()

  constructor(
    readonly address: `0x${string}`,
    private readonly chains: Chain[] = CHAINS,
  ) {}

  private client(chain: Chain): PublicClient {
    let client = this.clients.get(chain.id)
    if (!client) {
      client = createPublicClient({
        transport: http(chain.rpc),
        // Aggregate the reads into Multicall3 rather than firing one request per
        // token. Sixty tokens across seven addresses is over four hundred
        // `eth_call`s a scan, which public endpoints rate-limit — the balance
        // phase was slower run in parallel than in series because of it. Batched
        // it is a handful of calls per chain. Verified present at the canonical
        // address on all ten chains; viem only batches when it knows the
        // deployment, which is why the chain stub below exists at all.
        batch: { multicall: { wait: 20 } },
        chain: {
          id: chain.id,
          name: chain.name,
          nativeCurrency: { name: chain.native, symbol: chain.native, decimals: 18 },
          rpcUrls: { default: { http: [chain.rpc] } },
          contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
        },
      }) as PublicClient
      this.clients.set(chain.id, client)
    }
    return client
  }

  /** Native and registered token balances across every configured chain. */
  async balances(): Promise<{ balances: TokenBalance[]; errors: string[] }> {
    const balances: TokenBalance[] = []
    const errors: string[] = []

    await Promise.all(
      this.chains.map(async (chain) => {
        const client = this.client(chain)
        const tokens = TOKENS.filter((t) => t.chainId === chain.id && !t.historic)

        try {
          const native = await client.getBalance({ address: this.address })
          const quantity = Number(formatUnits(native, 18))
          if (quantity > 0) {
            balances.push({
              chain: chain.name,
              chainId: chain.id,
              symbol: chain.native,
              contract: null,
              quantity,
              dust: false,
            })
          }
        } catch (err) {
          // Never recorded as zero: a zero reads as "reconciled".
          errors.push(`${chain.name}: native balance — ${(err as Error).message.split('\n')[0]}`)
        }

        await Promise.all(
          tokens.map(async (token) => {
            try {
              const [raw, decimals] = await Promise.all([
                client.readContract({
                  address: token.address,
                  abi: erc20Abi,
                  functionName: 'balanceOf',
                  args: [this.address],
                }),
                tokenDecimals(client, token),
              ])
              const quantity = Number(formatUnits(raw, decimals))
              if (quantity > 0) {
                balances.push({
                  chain: chain.name,
                  chainId: chain.id,
                  symbol: token.symbol,
                  contract: token.address,
                  quantity,
                  dust: token.dust === true,
                })
              }
            } catch (err) {
              errors.push(`${chain.name}/${token.symbol}: ${(err as Error).message.split('\n')[0]}`)
            }
          }),
        )
      }),
    )

    return { balances, errors }
  }

  /**
   * Asserts every registry entry is the token it claims to be, by reading the
   * contract's own symbol.
   *
   * A wrong address is the failure mode with no symptom: `balanceOf` succeeds and
   * returns a real number for the wrong asset. This is also the guard against the
   * documented currency trap, where an asset coded plain `BTC` is Bitcoin EUR.
   */
  async verifyRegistry(): Promise<RegistryProblem[]> {
    const problems: RegistryProblem[] = []

    await Promise.all(
      this.chains.map(async (chain) => {
        const client = this.client(chain)
        await Promise.all(
          TOKENS.filter((t) => t.chainId === chain.id && !t.historic).map(async (token) => {
            try {
              const onChain = await client.readContract({
                address: token.address,
                abi: erc20Abi,
                functionName: 'symbol',
              })
              // Registry symbols follow Wealthfolio's naming, which does not always
              // match the contract's (WSTETH vs wstETH), so compare case-insensitively.
              if (onChain.toUpperCase() !== token.symbol.toUpperCase()) {
                problems.push({
                  chainId: chain.id,
                  symbol: token.symbol,
                  problem: `contract reports "${onChain}" — registry address is wrong`,
                })
              }
            } catch (err) {
              problems.push({
                chainId: chain.id,
                symbol: token.symbol,
                problem: `unreadable: ${(err as Error).message.split('\n')[0]}`,
              })
            }
          }),
        )
      }),
    )

    return problems
  }
}
