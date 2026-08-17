/**
 * Chain and token registry.
 *
 * All on-chain reads go over public RPC. There is no block-explorer API and no
 * key: one transport for wallet balances and protocol positions alike. That also
 * covers Base and Optimism, which Etherscan's free tier refuses outright.
 */

export type Chain = {
  id: number
  name: string
  rpc: string
  /** Native token symbol, as Wealthfolio would name it. */
  native: string
  /** Aave V3 Pool, where the protocol is deployed. */
  aavePool?: `0x${string}`
  /**
   * RPC that serves `eth_getLogs`. Deliberately separate from `rpc`: publicnode
   * serves balances happily but rejects log queries as "archive requests", so the
   * transfer tracker needs a different endpoint per chain.
   *
   * Undefined means no free endpoint was found that serves logs usefully — those
   * chains are balance-only, covered by the drift report but not the tracker.
   */
  logRpc?: string
  /** Max block span per getLogs call; every endpoint caps this differently. */
  logChunk?: number
  /**
   * Pause between requests for this chain. Some free endpoints rate-limit far
   * more aggressively than others — drpc's public Optimism and Avalanche
   * endpoints both fail under the default pace.
   */
  logPaceMs?: number
  /**
   * Blockscout-style, Etherscan-compatible API — keyless. The only way to see
   * **native** transfers: they emit no log, so `eth_getLogs` cannot find them,
   * and no RPC method lists transactions by address. Also yields gas spend.
   *
   * Note: do not pass `endblock` — Arbitrum's block numbers exceed the value
   * most examples use (99999999) and the query silently returns nothing.
   */
  explorerApi?: string
}

export const CHAINS: Chain[] = [
  {
    id: 1,
    name: 'Ethereum',
    explorerApi: 'https://eth.blockscout.com/api',
    logRpc: 'https://rpc.flashbots.net',
    logChunk: 5000,
    rpc: 'https://ethereum-rpc.publicnode.com',
    native: 'ETH',
    aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  },
  {
    id: 42161,
    name: 'Arbitrum',
    explorerApi: 'https://arbitrum.blockscout.com/api',
    logRpc: 'https://arb1.arbitrum.io/rpc',
    logChunk: 9000,
    rpc: 'https://arbitrum-one-rpc.publicnode.com',
    native: 'ETH',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  },
  {
    id: 100,
    name: 'Gnosis',
    logRpc: 'https://rpc.gnosischain.com',
    logChunk: 40000,
    rpc: 'https://gnosis-rpc.publicnode.com',
    native: 'XDAI',
    aavePool: '0xb50201558B00496A145fE76f7424749556E326D8',
  },
  {
    id: 137,
    name: 'Polygon',
    // drpc refuses eth_getLogs on its free tier regardless of span, despite an
    // error message that blames the block range.
    logRpc: 'https://polygon.gateway.tenderly.co',
    logChunk: 3000,
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    native: 'POL',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  },
  {
    id: 8453,
    name: 'Base',
    explorerApi: 'https://base.blockscout.com/api',
    logRpc: 'https://mainnet.base.org',
    logChunk: 9000,
    rpc: 'https://base-rpc.publicnode.com',
    native: 'ETH',
    aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  },
  {
    id: 10,
    name: 'Optimism',
    // mainnet.optimism.io rate-limits by IP within a single backfill.
    logRpc: 'https://optimism.drpc.org',
    logChunk: 4000,
    logPaceMs: 1500,
    rpc: 'https://optimism-rpc.publicnode.com',
    native: 'ETH',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  },
  {
    id: 56,
    name: 'BNB Chain',
    rpc: 'https://bsc-rpc.publicnode.com',
    native: 'BNB',
    aavePool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  },
  {
    id: 43114,
    name: 'Avalanche',
    logRpc: 'https://avalanche.drpc.org',
    logChunk: 2000,
    logPaceMs: 1200,
    rpc: 'https://avalanche-c-chain-rpc.publicnode.com',
    native: 'AVAX',
    aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  },
  // Plasma has no Aave deployment; XPL is its native token.
  { id: 9745, name: 'Plasma', rpc: 'https://rpc.plasma.to', native: 'XPL', logRpc: 'https://rpc.plasma.to', logChunk: 9000 },
  { id: 143, name: 'Monad', rpc: 'https://rpc.monad.xyz', native: 'MON' },
]

export type TokenSpec = {
  chainId: number
  /** Symbol as Wealthfolio names the asset, which is what the drift report joins on. */
  symbol: string
  address: `0x${string}`
  /**
   * Airdropped spam with no value. Registered so coverage matches what a
   * portfolio tracker sees, but excluded from the drift report by default —
   * these will never be booked in Wealthfolio, so reporting them as missing
   * every run is pure noise. Counted in a note so the exclusion stays visible.
   */
  dust?: true
}

/**
 * Tokens Spark reads balances for.
 *
 * Dropping block-explorer discovery means this list, not transfer history,
 * defines what gets checked — so a token that is not here is invisible. That is a
 * deliberate trade: the Wealthfolio API cannot create assets for an unknown
 * contract anyway, so an undeclared token could never be booked. `Wallet.verify()`
 * asserts every entry really is the token claimed, because a wrong address does
 * not error — it silently returns someone else's balance.
 */
export const TOKENS: TokenSpec[] = [
  // Ethereum
  { chainId: 1, symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { chainId: 1, symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  { chainId: 1, symbol: 'XAUT', address: '0x68749665FF8D2d112Fa859AA293F07A622782F38' },
  { chainId: 1, symbol: 'EURC', address: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c' },
  // Arbitrum
  { chainId: 42161, symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  { chainId: 42161, symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548' },
  { chainId: 42161, symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' },
  { chainId: 42161, symbol: 'WSTETH', address: '0x5979D7b546E38E414F7E9822514be443A4800529' },
  // Gnosis
  { chainId: 100, symbol: 'WSTETH', address: '0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6' },
  { chainId: 100, symbol: 'WBTC', address: '0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252' },
  { chainId: 100, symbol: 'USDC', address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83' },
  // Note: 0xcB44…C56E on Gnosis is EURe (Monerium), not EURC — a different asset.
  // Left out deliberately; verifyRegistry() caught it.
  // Polygon
  { chainId: 137, symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  { chainId: 137, symbol: 'WBTC', address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6' },
  // Base
  { chainId: 8453, symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { chainId: 8453, symbol: 'EURC', address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42' },
  { chainId: 8453, symbol: 'WSTETH', address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452' },
  // Avalanche
  { chainId: 43114, symbol: 'WAVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7' },
  { chainId: 43114, symbol: 'USDC', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' },
  // Arbitrum
  { chainId: 42161, symbol: 'PENDLE', address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8' },
  // Gnosis
  { chainId: 100, symbol: 'WETH', address: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1' },
  // Plasma
  { chainId: 9745, symbol: 'WXPL', address: '0x6100E367285b01F48D07953803A2d8dCA5D19873' },
  // Wrapped native. Swaps route through WETH and it is then unwrapped to native
  // ETH, so without these the swap leg reads as an unregistered token.
  { chainId: 1, symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  { chainId: 42161, symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  { chainId: 8453, symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' },
  { chainId: 10, symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' },
  { chainId: 137, symbol: 'WETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' },
  // Aave aTokens. Redeeming these is what the 3 August "swaps" actually were —
  // the difference between burned and received is accrued interest, not a trade.
  { chainId: 42161, symbol: 'aArbUSDCn', address: '0x724dc807b04555b71ed48a6896b6f41593b8c637' },
  { chainId: 8453, symbol: 'aBasEURC', address: '0x90da57e0a6c0d166bf15764e03b83745dc90025b' },
  // ether.fi. Verified on-chain by symbol()/name() and cross-checked against
  // the protocol's deployed-contracts docs.
  { chainId: 1, symbol: 'eETH', address: '0x35fA164735182de50811E8e2E824cFb9B6118ac2' },
  { chainId: 1, symbol: 'weETH', address: '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee' },
  { chainId: 1, symbol: 'ETHFI', address: '0xFe0c30065B384F05761f15d0CC899D4F9F9Cc0eB' },
  { chainId: 8453, symbol: 'weETH', address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A' },
  { chainId: 42161, symbol: 'weETH', address: '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe' },
  // Airdropped spam, zero value — see TokenSpec.dust
  { chainId: 56, symbol: 'FSP', address: '0xdc84096074269d8f304d476124101249d105b60d', dust: true },
  { chainId: 56, symbol: '毒王', address: '0xecf897960b239c15ef19e0a07b50fd1ae9e37777', dust: true },
  { chainId: 56, symbol: '比特币', address: '0x18d0e455b3491e09210292d3953157a4bf104444', dust: true },
  { chainId: 8453, symbol: 'ANTHRAX', address: '0x904efbbaab6cf3e4499968af1b68aa54d5b586df', dust: true },
  { chainId: 8453, symbol: 'BDOGE', address: '0xb3ecba1330fe26bb36f40344992c481c2c916f23', dust: true },
  { chainId: 8453, symbol: 'ChatGPT', address: '0x7a61c05d51ef2aca38cb94117cb701cd70f4d236', dust: true },
  { chainId: 8453, symbol: 'FARTWARS', address: '0x22382c9690e1745bc1b5409bbc6222da6d3b6221', dust: true },
  { chainId: 8453, symbol: 'GOOFS', address: '0x8e5c04f82d6464b420e2018362e7e7ab813cf190', dust: true },
  { chainId: 8453, symbol: 'HIV', address: '0xe8903d1fa9aa85b00b12a41c965c794687c87f5c', dust: true },
  { chainId: 8453, symbol: 'QTG', address: '0xb4df5f42a2133933b6ab6bda8037cab6e5604df1', dust: true },
  { chainId: 8453, symbol: 'SAMURAI', address: '0xe0c282edce6dddf98e3ef6b29246a2bf632b7010', dust: true },
  { chainId: 8453, symbol: 'SKIBIDI', address: '0x660e8b9ac921fd92691e52a574e5678367326126', dust: true },
  { chainId: 8453, symbol: 'SKYA', address: '0x623cd3a3edf080057892aaf8d773bbb7a5c9b6e9', dust: true },
  { chainId: 8453, symbol: 'SNL', address: '0xc5a861787f3e173f2b004d5cfa6a717f5dc5484d', dust: true },
  { chainId: 8453, symbol: 'STHY', address: '0x6fdf95f513657c09ab25ff3bfd336e52ef5ec9b6', dust: true },
  { chainId: 8453, symbol: 'SWOL', address: '0xa1ca6299ba48366af1845a9a8ae59b87ff0d5c01', dust: true },
  { chainId: 8453, symbol: 'USA', address: '0xb56d0839998fd79efcd15c27cf966250aa58d6d3', dust: true },
  { chainId: 8453, symbol: 'WEB3', address: '0xeb3458ad201bd39263e3a938175651216e0f2f25', dust: true },
  { chainId: 8453, symbol: 'WGC', address: '0xfb18511f1590a494360069f3640c27d55c2b5290', dust: true },
  { chainId: 8453, symbol: 'toby', address: '0xb8d98a102b0079b69ffbc760c8d857a31653e56e', dust: true },
  { chainId: 8453, symbol: 'xADA', address: '0xb0c26970e9dad9b5162fcaab1a5d13e604a6d9ac', dust: true },
]

export const chainById = (id: number): Chain | undefined => CHAINS.find((c) => c.id === id)
