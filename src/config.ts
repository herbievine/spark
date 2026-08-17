/**
 * Spark's address book and registries.
 *
 * Wealthfolio stores wallet addresses in `accounts.account_number`, but the MCP
 * surface does not expose that field, so it is read from the database directly
 * (read-only). Two accounts have a blank `account_number` and one shares its
 * address with another, neither of which the database can express — hence the
 * overrides and the explicit venue map below.
 */

export type Venue = 'evm' | 'safe' | 'hyperliquid'

export type WalletAccount = {
  /** Wealthfolio account name — the join key against the accounts table. */
  name: string
  venue: Venue
  address: string
  accountId: string
}

/**
 * Wallets to track, from `SPARK_WALLETS`.
 *
 * Addresses live in the environment rather than in the repository. They are
 * public on-chain either way, but committing them here would tie them to a named
 * GitHub account and de-anonymise every transaction those wallets ever make.
 *
 * Format: comma-separated `name:venue:address`, where venue is
 * `evm` | `safe` | `hyperliquid`.
 *
 *   SPARK_WALLETS="Hot Wallet:evm:0xabc…,Multisig:safe:0xdef…,HL:hyperliquid:0xabc…"
 *
 * The venue cannot be derived from the chain: a Safe looks like any other
 * address until you ask it, and Hyperliquid is a venue keyed by an address it
 * shares with the wallet that funds it.
 */
function parseWallets(): { name: string; venue: Venue; address: string }[] {
  const raw = process.env.SPARK_WALLETS?.trim()
  if (!raw) return []

  const out: { name: string; venue: Venue; address: string }[] = []
  for (const entry of raw.split(',')) {
    const parts = entry.split(':').map((p) => p.trim())
    if (parts.length !== 3) {
      throw new Error(`SPARK_WALLETS entry must be "name:venue:address", got "${entry}"`)
    }
    const [name, venue, address] = parts as [string, Venue, string]
    if (!['evm', 'safe', 'hyperliquid'].includes(venue)) {
      throw new Error(`SPARK_WALLETS: unknown venue "${venue}" for "${name}"`)
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new Error(`SPARK_WALLETS: "${address}" is not an address (${name})`)
    }
    out.push({ name, venue, address })
  }
  return out
}

export const WALLETS = parseWallets()

/** Which provider answers for each account. */
export const VENUES: Record<string, Venue> = Object.fromEntries(
  WALLETS.map((w) => [w.name, w.venue]),
)

/**
 * Address per account name, from `SPARK_WALLETS`.
 *
 * Wealthfolio stores addresses in `accounts.account_number`, but leaves it blank
 * for the Safe and for Hyperliquid, and its MCP surface does not expose the field
 * at all — so configuration is the source of truth and the database is a
 * cross-check.
 *
 * Two accounts may deliberately share an address (Hyperliquid is keyed by the
 * wallet that funds it). The book is keyed on name, never on address, so those
 * do not collapse into one entry and double-count.
 */
export const ADDRESS_OVERRIDES: Record<string, string> = Object.fromEntries(
  WALLETS.map((w) => [w.name, w.address]),
)

/**
 * Contracts that are really one of Herbie's own accounts wearing a different hat.
 *
 * The Hyperliquid deposit bridge was identified empirically, from the 3,000 USDC
 * that left the Nano X on 2026-08-11 and arrived as Hyperliquid balance — not
 * from documentation. A transfer here is an internal move into the Hyperliquid
 * account, not money leaving the portfolio, and misclassifying it as a
 * withdrawal would corrupt every return figure.
 */
export const KNOWN_COUNTERPARTIES: Record<string, string> = {
  '0xa95d9c1f655341597c94393fddc30cf3c08e4fce': 'Hyperliquid',
}

/**
 * Counterparties that are venues rather than wallets: exchanges, and Zeal (a
 * smart-contract wallet used on Gnosis). Transfers here are not anonymous
 * external flows — they go somewhere known, and labelling them is what stops a
 * deposit to an exchange being booked as money leaving the portfolio.
 *
 * Populated from observed data rather than guessed: an address is only added
 * once it has been confirmed, because a wrong label silently misclassifies a
 * real movement.
 *
 * Set from `SPARK_VENUE_LABELS` as `address=label,address=label`. These live in
 * the environment for the same reason wallet addresses do: an ether.fi Cash
 * top-up proxy is deterministic *per user*, so publishing one here would tie a
 * named GitHub account to every payment that ever passed through it. The
 * previous hard-coded entry did exactly that.
 *
 * That proxy is worth labelling because it is not a protocol-level address:
 * `isTopUpContract()` is true and its owner is ether.fi's TopUpSourceFactory,
 * which has deployed ~84k sibling proxies all delegating to the shared `TopUpV2`
 * beacon — which is why the implementation name looks official. Treating it as
 * the protocol contract would fold other users' deposits into Herbie's flow.
 */
export const VENUE_LABELS: Record<string, string> = Object.fromEntries(
  (process.env.SPARK_VENUE_LABELS ?? '')
    .split(',')
    .map((entry) => entry.split('='))
    .filter((p): p is [string, string] => p.length === 2 && /^0x[a-fA-F0-9]{40}$/.test(p[0]!.trim()))
    .map(([address, label]) => [address.trim().toLowerCase(), label.trim()]),
)

/**
 * Hyperliquid coin -> Wealthfolio symbol. Hyperliquid's spot BTC and ETH are the
 * Unit-bridged variants, which carry different tickers to the assets they are
 * booked against.
 */
export const HL_SYMBOLS: Record<string, string> = {
  UBTC: 'BTC',
  UETH: 'ETH',
  HYPE: 'HYPE32196',
}

/** Coins held as account cash rather than as a position. */
export const HL_CASH_COINS = new Set(['USDC'])

/**
 * Quantity difference below which a position is considered reconciled. Chain
 * values carry more decimals than Wealthfolio stores, so exact equality is not a
 * reachable target; this is the noise floor, not a tolerance for real drift.
 */
export const QUANTITY_EPSILON = 1e-6

/** Cash difference, in account currency, below which no drift is reported. */
export const CASH_EPSILON = 0.01

/**
 * Holdings worth less than this in USD are not shown.
 *
 * Applied to *visibility only*, never to the comparison: drift is computed on
 * quantities, so a price can suppress a row but can never create or hide a
 * discrepancy in a row that is shown. A holding whose price cannot be determined
 * is shown rather than hidden, unless it is registered as spam — the failure
 * direction is towards noise, not towards silence.
 */
export const DUST_TOLERANCE_USD = 5
