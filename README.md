# Spark

Tracks on-chain wallet movements and reconciles them against self-hosted
[Wealthfolio](https://wealthfolio.app). Runs as a sidecar beside it.

Reads ten EVM chains, Bitcoin and Hyperliquid, plus Coinbase and Binance
exports, classifies every transfer (internal move, swap, redemption, exchange,
spam, spoof), and reports where the numbers disagree.

Both sides of a movement are booked where they belong: an exchange withdrawal
sits in the exchange account and the transfer that arrives sits in the wallet —
double-entry rather than duplication.

## Quick start

```sh
bun install
cp .env.example .env      # add your Wealthfolio agent token

bun run track             # scan for new movements
bun run ledger 2026       # what moved, per account and asset
bun run report            # drift vs Wealthfolio
bun run verify            # assert the token registry is correct
```

`bun run watch` runs the scan on a loop and serves HTTP:
`/health`, `/report`, `/defi`, `/movements`, `/ledger`, `/tracker`.

## Deploy

```sh
docker compose up -d --build
```

Mounts Wealthfolio's data directory read-only and keeps its own state in a
separate volume.

## What it does

| Job | Command | Question it answers |
|---|---|---|
| Track | `track` / `watch` | what moved, and when |
| Ledger | `ledger` | where did the money go |
| Drift | `report` | does Wealthfolio agree with the chain |
| Positions | `defi` | what is held inside protocols |
| Verify | `verify-transfers` | does the chain actually contain what the explorer claimed |

## How it reads data

- **Movements** come from block explorers (`tokentx`) where available, falling
  back to `eth_getLogs`. Transfer-based, not transaction-based, so it catches
  trades settled by a third party such as CoW Protocol.
- **Balances and protocol positions** come from contract calls over public RPC.
  No API keys, no paid providers.
- **Bitcoin** is derived from a watch-only extended public key and walked under
  the BIP44 gap limit; Esplora serves it without a key.
- **Wealthfolio** is read over MCP, plus one read-only SQLite lookup for the
  wallet addresses it stores but does not expose over the API. Writing needs REST
  with a session cookie, because MCP exposes no way to delete an activity.

## Safety

Spark is read-only by default and writes nothing to Wealthfolio unless the agent
token carries write scopes.

Rows it will not book are marked `doNotBook` with a reason — forged transfer
events, address-poisoning dust, and advertising spam are excluded from every
total but kept as evidence.

`bun run verify` checks every registry entry against the contract's own
`symbol()`, because a wrong address does not error: it silently returns the wrong
balance.

## Configuration

Chains and tokens live in `src/chains.ts`. Addresses, venue labels and keys are
**never committed** — they come from the environment (`SPARK_WALLETS`,
`SPARK_VENUE_LABELS`, `SPARK_BTC_ZPUB`), because publishing them here would tie a
named account to every transaction those wallets ever make.

[CLAUDE.md](CLAUDE.md) is the operating manual: commands, order of operations and
the traps already paid for. [NOTES.md](NOTES.md) explains why the design is what
it is.
