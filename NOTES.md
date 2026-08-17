# Spark

Keeps the on-chain wallets and the Hyperliquid account reconciled against
self-hosted Wealthfolio. Runs beside Wealthfolio as a sidecar.

**Read-only. It compares and prints, and writes nothing.**

## Running

```sh
bun install
bun run track           # Job C: scan for new movements once
bun run watch           # ...or continuously (this is what runs in production)
bun run movements       # what was captured, classified
bun run report          # Job A: quantity drift vs Wealthfolio
bun run defi            # Job B: protocol positions in USD
bun run verify          # assert every token registry entry is the token it claims
```

Endpoints: `GET /health`, `/report`, `/defi`, `/movements`, `/tracker`
(add `?format=json` to any).

## Deployment

Runs on the server as a sidecar beside Wealthfolio, on the shared `edge` network:

```sh
cd /srv/spark && docker compose up -d --build
docker logs -f spark
```

`SPARK_INTERVAL_MS` (default 300000) sets the scan cadence. The container runs
`watch`, which scans on that interval *and* serves the HTTP surface.

The Wealthfolio token lives in `/srv/spark/.env` (mode 0600, `env_file`
in compose — never baked into the image). Note `rsync --delete` from a dev
machine will remove it unless `--exclude .env` is passed.

### Checking on it

```sh
docker logs --tail 40 spark                      # last scan results
docker exec spark bun run src/index.ts movements # what was captured, classified
docker exec spark bun run src/index.ts report    # drift vs Wealthfolio
```

Running locally needs no Wealthfolio database: if `WF_DB_PATH` is absent, the
address book falls back to the addresses in `src/config.ts` and says so in the
report's issues. The database still wins when present. That means chain scanning
never requires a copy of your financial data on a dev machine.

State lives in the `spark_spark-state` volume (`/state/spark.db`): cursors,
transfers, balance snapshots, cached prices. **Do not delete it** — cursors are
what stop Spark rescanning from the epoch, and captured transfers may not be
re-fetchable.

The first run backfills from 1 January 2026, which takes hours (Arbitrum
alone is ~5M blocks per address at 9,000 per request). Subsequent runs scan only
minutes of new blocks. Progress commits per chunk, so restarting mid-backfill
resumes rather than restarting.

## Job C — movement tracking

Tracks from **2026-01-01** (`TRACKING_START` in `src/track.ts`) forward.

**Capture is separated from interpretation, and that split is the whole design.**
Free RPC endpoints will not serve arbitrarily old logs, so a movement not captured
reasonably soon may become unrecoverable — but a *classification* can be improved
and re-run against stored rows at any time. So the scanner's only job is to miss
nothing; `movements.ts` decides what it all meant, and can be rewritten freely.

Consequences of that:

- **Cursors advance per chunk**, committed with the transfers they cover, so an
  interrupted backfill resumes instead of restarting.
- **A failed range never advances the cursor** — the gap is retried rather than
  skipped, because a silently skipped range is a movement lost for good.
- The `watch` loop never exits on error. A crash stops capture.

### It scans logs, not transaction lists

This is a correctness requirement. **CoW Protocol trades are submitted by a
solver**, so the transaction's `from` is not you — anything enumerating "my
transactions" misses every CoW trade. Logs catch them, because the token still
moves to and from your address.

### Native transfers need an explorer, not an RPC

A plain ETH send emits **no event at all**, so `eth_getLogs` is structurally
blind to it — and no RPC method lists an address's transactions. A real case:
500 USDC swapped via CoW to WETH, unwrapped to native ETH, then sent to the
multisig. The swap legs appeared; the final ETH transfer was invisible.

The fix is Blockscout's keyless Etherscan-compatible `txlist`
(`explorerApi` per chain), which also returns `gasUsed`/`gasPrice` — so the same
call solves gas, including gas burned on approvals and failed transactions that
emit no log either.

Two traps found doing this:

- **Do not pass `endblock`.** Arbitrum's block numbers exceed the `99999999`
  most examples use, and the query then silently returns zero rows.
- **Native rows use their own cursor** (`<address>#native`). Sharing the log
  cursor would skip all history, since log scanning had already reached head.

Instances exist for Ethereum, Arbitrum and Base. Other chains have no reachable
free instance, so native transfers there remain uncaptured.

### Classification needs no protocol adapters

The unit is the **transaction**, not the transfer. Netting every transfer within
one transaction resolves most ambiguity without decoding anything: if one asset
leaves and another arrives in the same transaction, it is a swap, and the ratio is
the execution price. Identical treatment for Uniswap, CoW or anything else, with
no per-DEX adapter to maintain — and the price comes from the trade itself, so it
can never disagree with Wealthfolio's market data.

Kinds: `internal` (both sides tracked), `swap`, `redemption`, `deposit`,
`withdrawal`, `exchange-in`/`exchange-out`, `dust-attack`, and `spoof`.

### Counterparties: exchanges and Zeal

`WITHDRAWAL` is an *external flow* in Wealthfolio, so booking a transfer to a
venue you still own as one corrupts every return figure. `counterparties.ts`
resolves who is on the other side, from three sources:

- **Known exchange hot wallets**, from Etherscan's public tags. This can never be
  exhaustive — exchange *deposit* addresses are generated per user, so yours
  appears on no public list and must be added to `VENUE_LABELS` once observed.
- **On-chain introspection**, which is the only way to recognise Zeal: a Zeal
  wallet is a **Safe 1.4.1** contract at a per-user address, so it is identified
  by asking the contract its `VERSION()` rather than by any list. On Gnosis a
  Safe is overwhelmingly Zeal or Gnosis Pay, since that is what they deploy.
  (Verified: your own multisig answers `1.4.1`, the same version.)
- **`VENUE_LABELS`** for anything the first two miss.

Blockscout was evaluated as a fourth source and **rejected**: its public
instances return empty `public_tags` even for addresses Etherscan labels
clearly, so it cannot identify exchanges.

### `redemption` and `spoof`

Two classifications that exist because the naive reading was wrong:

- **`redemption`** — burning a receipt token for its underlying is not a trade.
  Two 3 August movements looked like swaps at strange rates; they were Aave
  exits, and the difference (+14.148461 USDC, +12.719747 EURC) is **accrued
  interest**. Booking them as swaps would record a bogus rate and lose the income.
- **`spoof`** — any contract can emit a `Transfer` event naming any address, so
  an unregistered token claiming your address moved funds proves nothing. Seen
  here as a forged WBTC whose symbol used Unicode homoglyphs (Lisu and Cherokee
  letters imitating Latin), paired with lookalike addresses. **No value moved**;
  booking it would invent a movement.

The Hyperliquid deposit bridge (`0x<addr>…ce`, identified empirically
from a real 3,000 USDC deposit, not from documentation) is registered in
`KNOWN_COUNTERPARTIES` so a deposit there classifies as an **internal** move into
the Hyperliquid account rather than a withdrawal. That distinction matters:
`WITHDRAWAL` is an external flow in Wealthfolio and would corrupt returns.

Worked example — the canonical journey, as captured:

```
2026-08-11T18:05  internal  Multisig Wallet  -3000 USDC
2026-08-11T18:05  internal  Nano X           +3000 USDC
2026-08-11T18:06  internal  Nano X           -3000 USDC
2026-08-11T18:06  internal  Hyperliquid      +3000 USDC
```

Note that classification keys on **address**, not account name: Hyperliquid's
`account_number` is the Nano X address, so resolving a name back to an address
would attribute the bridge's side of a transfer to the wrong wallet.

### Reading the output

An inbound `deposit` of an `UNKNOWN:0x…` token is almost always **airdrop spam**,
not money arriving. The signature is unregistered contracts delivering round
amounts to several wallets independently — Plasma produced five such rows across
all four addresses in the first backfill. Registered tokens are the ones that
matter; unknown ones are surfaced only because a silent drop would hide a real
movement, and the Wealthfolio API cannot create assets for them anyway.

### Address poisoning is detected

The first minutes of tracking caught one: 0.000099 USDC arriving from
`0x<addr>…d0`, moments after a real 1000 USDC transfer from the multisig
at `0x<addr>…d0` — same first and last four characters. The point of the
attack is that you later copy the wrong address out of your history. Any inbound
transfer from an address sharing another known address's leading and trailing
characters is flagged `dust-attack`.

## The ledger

```sh
bun run ledger 2026            # per-account, per-asset summary
bun run ledger 2026 csv        # one auditable row per leg
bun run ledger 2026 json
```
Also `GET /ledger?year=2026&format=csv`.

One row per **leg**, so an internal transfer produces two — one per account —
and each account balances on its own. Every row carries the evidence to check it
independently: chain, block, tx hash, log index, both addresses, and the **raw
integer value** alongside the scaled one. `rawValue` is the authority; token
amounts routinely exceed double precision (USDC has 6 decimals, most have 18),
so `quantity` is for reading and `rawValue` is what reconciles.

`doNotBook` is set on rows that must never reach Wealthfolio — spoofed transfers
(no value moved) and address-poisoning dust (an attack, not income). They are
kept in the ledger, because deleting evidence of an attack is worse than
carrying it, but they are excluded from every total.

### Unvetted symbols carry a `?`

Where the registry knows a contract, its symbol is used, because those match
Wealthfolio's naming. Otherwise the explorer's symbol is shown with a trailing
`?`. That is far more useful than a bare contract address — it surfaced Pendle
PTs, GHO and Aave debt tokens that were previously unreadable — but a hostile
contract can call itself anything, so an unvetted name is a hint, never an
identity. Two spoofs in the data render as `ꓪᏴꓔᏟ?` and `ЕТΗ?`: Unicode
homoglyphs of WBTC and ETH.

### Backfill uses `tokentx`, not `eth_getLogs`

Paging logs is bounded by the endpoint's block-range cap rather than by how much
happened. A year of Arbitrum is ~95M blocks, so at 9,000 per request that is
~21,000 requests **per address**. Measured: 11.5 hours covered two chains.

The explorer's `tokentx` returns an address's entire history in **one request**,
and — unlike `txlist` — it is transfer-based rather than transaction-based, so it
still catches CoW Protocol trades where a solver submits the transaction and the
user is not `tx.from`. Verified against a real CoW fill. Log paging remains the
fallback for chains with no explorer instance.

`SPARK_TRACKING_START` (an ISO date) narrows the window while iterating.

### Not yet writing

Spark still writes nothing to Wealthfolio. The agent token is read-only by design,
so posting activities needs the draft/commit scopes added first. Capture is the
part that cannot be deferred; posting can be done at any time from stored rows.

## Design

Two kinds of thing, split by what they hold rather than by where the data comes
from — because the data source is the part that keeps changing.

**`Wallet`** — what an address holds *directly*, as **quantities**. Reconciles
against Wealthfolio holdings, which are quantities.

**`Protocol`** — value an address holds *inside* something, in **USD**. Accrues
with no transfer to observe, so no transaction feed will ever catch it. Concrete
protocols: `AaveV3`, `Hyperliquid`.

```ts
class Wallet {
  balances(): Promise<{ balances: TokenBalance[]; errors: string[] }>
  verifyRegistry(): Promise<RegistryProblem[]>
}

abstract class Protocol {
  abstract readonly name: string
  abstract positions(address: string): Promise<ProtocolResult>
}
```

Valuation belongs to the protocol because the protocol is the authority on it —
Aave's oracle prices Aave collateral, Hyperliquid's mids price Hyperliquid spot.

**No price feed ever enters a comparison.** Job A reconciles quantities, which need
no prices at all. Wealthfolio has its own market data, and letting a second price
source into the comparison would make Spark report drift its own pricing invented.
An external price is used in exactly one place — deciding whether a row clears
`DUST_TOLERANCE_USD` and is worth printing — where being wrong costs visibility,
not correctness.

## Two jobs, two cadences

Kept separate on purpose — conflating them is the main way this design goes wrong.

- **Job A, `/report`** — event-shaped: what moved, and does Wealthfolio agree. Fast.
- **Job B, `/defi`** — positions that drift silently. Daily: lending positions do
  not move meaningfully between breakfast and lunch, and running this on Job A's
  cadence would multiply requests by 48 to learn nothing new.

## On-chain reads

One transport: **viem over public RPC**. No block-explorer API, no key, no vendor,
no rate limit, and it works on a Raspberry Pi. It also covers Base and Optimism,
which Etherscan's free tier refuses outright.

The trade-off is that the **token registry**, not transfer history, defines what
gets checked — a token absent from `TOKENS` is invisible. That is acceptable
because the Wealthfolio API cannot create assets for an unknown contract anyway,
so an undeclared token could never be booked.

`bun run verify` guards the registry by reading each contract's own `symbol()`. A
wrong address is the failure mode with no symptom: `balanceOf` succeeds and
returns a real number for the wrong asset. This has already caught one — the
Gnosis address that looks like EURC reports **EURe** (Monerium), a different asset.

## Credentials

Read from the environment, falling back to the macOS Keychain for local dev, so
the token is never written to a file. Job B and `verify` need no credentials at
all — contract reads require no key.

| | Env | Keychain service |
|---|---|---|
| Wealthfolio PAT | `WF_AGENT_TOKEN` | `spark-wf-token` |

Also honoured: `WF_BASE_URL`, `WF_DB_PATH`, `PORT`.

## How it reads Wealthfolio

- **MCP at `/mcp`** for holdings, cash and accounts. The PAT authenticates *only*
  this endpoint — REST under `/api/v1` rejects it with 401 and takes nothing but
  the `wf_session` cookie. Needs `WF_MCP_ENABLED=true` on the server.
- **The SQLite database, read-only**, for one field: `accounts.account_number`,
  which holds the wallet addresses. MCP's `get_accounts` cannot return it in
  either display mode.

Reading is all that is done against the database. Writes would bypass the
valuation engine that turns activities into holdings, and a second writer on a WAL
database risks corruption.

**Mount the whole data directory, not just the `.db` file** — SQLite needs the
`-wal` and `-shm` sidecars to see committed data.

```yaml
volumes:
  - /srv/wealthfolio.example.com/data:/data:ro
```

## Address book

Built from `account_number`, with two gaps closed in `src/config.ts`:

- `Multisig Wallet` and `Hyperliquid` have a **blank** `account_number`. Filling
  those two fields in Wealthfolio would let the overrides be deleted.
- `Hyperliquid` deliberately shares the Nano X address. The book keys on account
  name, never on address, so the two cannot collapse into one entry — a
  per-address view of the Nano X already contains the Hyperliquid balance, and
  merging them would double-count.

## Reconciliation notes

- **Wealthfolio holds one quantity per symbol per account**, but the same asset
  can sit on several chains. The drift report compares the **sum across chains**
  against that single holding; matching per chain would let the first chain claim
  the whole holding and report every other chain as missing.

- **Hyperliquid's spot balance already contains the perp margin:**

  ```
  spot USDC total = available + hold
  hold            = open order notional + perp margin
  ```

  So adding `clearinghouseState.accountValue` to the spot total double-counts the
  collateral. Equity uses the non-overlapping parts:
  `available + open bids + spot tokens + perp margin`.

  Wealthfolio's cash is compared against **spot USDC total** alone. Only realised
  PnL is booked, so an open position leaves cash drift roughly equal to its
  unrealised PnL — expected, and named in the report rather than chased.

- **Hyperliquid spot prices need care.** `spotMetaAndAssetCtxs` returns a
  `universe` and a context array of *different lengths* (324 vs 715), so they
  cannot be zipped positionally — join on the context's own `coin` field. And
  token names are not unique: more than one listed token is called `HYPE`, so the
  join must use the token **index** the balance reports. Both mistakes yield
  prices that look plausible and are wrong by orders of magnitude.

- A provider failure is always an alert, never a zero balance — a zero reads as
  "everything reconciles".

- **`DUST_TOLERANCE_USD` ($5) controls visibility only.** Drift is computed on
  quantities; prices decide nothing except whether a row is worth printing, so a
  wrong price can suppress a row but can never create or mask a discrepancy in a
  row that is shown. Two guards follow from that:

  - A holding Wealthfolio *does* hold is **never** hidden, whatever it is worth —
    that is exactly where a real discrepancy lives.
  - An **unknown** price is not treated as small. Anything CoinGecko cannot price
    is shown, so the failure direction is noise rather than silence.

  Everything suppressed is itemised in the report's NOTES, so the exclusion is
  always visible rather than silent.

## Why not DeBank

Its API needs a $200 minimum top-up, and it reads the same contracts Spark now
reads directly. Reading protocols one at a time also makes a known double-count
impossible: a per-address DeBank view of the Nano X **includes Hyperliquid**
($3,007 of $3,034), which Wealthfolio already tracks as its own account.

DeBank remains useful as a *cross-check*. Spark's wallet coverage was verified
against it across all four addresses: **60 balances matched, 0 differences.** That
comparison is what found the missing chains (BNB Chain, Avalanche, Plasma, Monad)
and the missing tokens (`WXPL`, `PENDLE`, `WETH`, `WBTC` beyond Ethereum).

## Known gaps

**BNB Chain and Monad have no log-capable free RPC** (BNB's dataseeds reject
`eth_getLogs`; Monad caps it at a 100-block range). Those two chains are
balance-only — the drift report sees them, the tracker does not. Everything of
value there is under $15.

**Log RPCs are per-chain and fussy**, which is why `logRpc` is separate from
`rpc`. Found the hard way, each from a real failure during backfill:

| Chain | Endpoint | Why not the obvious one |
|---|---|---|
| Ethereum | `rpc.flashbots.net` | publicnode calls log queries "archive requests" |
| Base | `mainnet.base.org` | 10k range cap |
| Arbitrum | `arb1.arbitrum.io/rpc` | — |
| Gnosis | `rpc.gnosischain.com` | — |
| Polygon | `polygon.gateway.tenderly.co` | drpc refuses logs on free tier regardless of span, while blaming the block range |
| Optimism | `optimism.drpc.org` | `mainnet.optimism.io` rate-limits by IP mid-backfill |
| Avalanche | `avalanche.drpc.org` | the official RPC caps range hard |
| Plasma | `rpc.plasma.to` | — |

Requests are paced (`PACE_MS`, overridable per chain via `logPaceMs` — Optimism
and Avalanche both need a much slower rate than the default) and each request
retries once after a pause. Free endpoints fail transiently as a matter of
course: "no backend is currently healthy", "temporary internal error", per-second
rate limits. Without the retry a single blip stalls that chain's cursor for a
whole cycle, which on a chain paged in 2,000-block chunks means the backfill
barely advances.

Failures are self-healing regardless: the cursor never advances past a failed
range, so the next pass retries it. A chain can therefore converge slowly without
ever losing data.

**Prices come from CoinGecko's keyless endpoint, which rate-limits hard** — 429s
within minutes of sustained use. Hence the 6-hour price cache. Prices only ever
decide whether a row clears `DUST_TOLERANCE_USD`, so a stale or missing price
costs visibility, never correctness.

## Not yet covered

Protocol adapters. Only `AaveV3` and `Hyperliquid` exist, so positions in these —
all seen on DeBank against these same addresses — are currently invisible to Job B:

| Protocol | Where | Approx |
|---|---|---|
| XMAQUINA | Hot Wallet, Base | $52.99 |
| Euler | Nano X, Arbitrum | dust |
| LIDO | Hot Wallet | dust |
| Merkl | Multisig, Plasma | $0.02 |

Morpho and Pendle are likewise uncovered. Each needs a `Protocol` subclass; the
seam is in place, so adding one touches nothing else.
