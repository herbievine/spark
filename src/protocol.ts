/**
 * A protocol: value an address holds *inside* something, rather than directly.
 *
 * The distinction from Wallet is not cosmetic. A wallet balance is a quantity of
 * an asset and reconciles against a Wealthfolio holding. A protocol position
 * accrues value with no transfer to observe, is denominated in USD by the
 * protocol's own oracle, and has no Wealthfolio counterpart until it is booked.
 * They answer different questions on different cadences.
 *
 * Valuation is the protocol's job precisely because the protocol is the authority
 * on it — Aave's oracle prices Aave collateral, Hyperliquid's mids price
 * Hyperliquid spot. Spark never introduces a price feed of its own, which is what
 * stops it reporting drift that its own pricing invented.
 */

export type Position = {
  protocol: string
  chain: string
  suppliedUsd: number
  borrowedUsd: number
  /** Supplied minus borrowed. */
  netUsd: number
}

export type ProtocolResult = {
  positions: Position[]
  /** Provider failures. Never folded into positions as a zero, which would read as reconciled. */
  errors: string[]
  /** Informational breakdowns; never a reason to fail a run. */
  notes: string[]
}

export abstract class Protocol {
  abstract readonly name: string

  /** Positions this protocol holds for the given address. */
  abstract positions(address: string): Promise<ProtocolResult>
}
