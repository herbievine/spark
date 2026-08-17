/**
 * Spark's own state: scan cursors, captured transfers, and balance snapshots.
 *
 * Deliberately a separate database from Wealthfolio's. Wealthfolio's is read-only
 * to Spark, and this one has to be written on every run.
 *
 * This is the part that is time-critical. Free RPC endpoints cap how far back
 * `eth_getLogs` will reach, so a movement not captured reasonably soon after it
 * happens may become unrecoverable. Capture is therefore separated from
 * interpretation: raw transfers are stored verbatim and can be re-classified
 * later, but they cannot be re-fetched later.
 */

import { Database } from 'bun:sqlite'

export type TransferRow = {
  chainId: number
  txHash: string
  logIndex: number
  blockNumber: number
  blockTime: number
  contract: string | null
  symbol: string
  fromAddr: string
  toAddr: string
  /** Decimal string — never a float. Token amounts exceed float precision. */
  rawValue: string
  decimals: number
}

export class SparkState {
  private readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    // Another Spark process (a maintenance command) may hold the lock briefly.
    // Waiting beats failing a scan, since a failed scan leaves a gap.
    this.db.exec('PRAGMA busy_timeout = 30000')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cursors (
        chain_id     INTEGER NOT NULL,
        address      TEXT    NOT NULL,
        last_block   INTEGER NOT NULL,
        updated_at   TEXT    NOT NULL,
        PRIMARY KEY (chain_id, address)
      );

      -- The idempotency ledger the design calls for. Wealthfolio's own duplicate
      -- detection keys on calendar day, so it can never be trusted for this;
      -- chainId:txHash:logIndex is the only stable identity a transfer has.
      CREATE TABLE IF NOT EXISTS transfers (
        chain_id     INTEGER NOT NULL,
        tx_hash      TEXT    NOT NULL,
        log_index    INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        block_time   INTEGER NOT NULL,
        contract     TEXT,
        symbol       TEXT    NOT NULL,
        from_addr    TEXT    NOT NULL,
        to_addr      TEXT    NOT NULL,
        raw_value    TEXT    NOT NULL,
        decimals     INTEGER NOT NULL,
        posted_at    TEXT,
        PRIMARY KEY (chain_id, tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS transfers_time ON transfers (block_time);
      CREATE INDEX IF NOT EXISTS transfers_unposted ON transfers (posted_at) WHERE posted_at IS NULL;

      -- Native-token movement produces no log, so it is tracked by snapshot.
      -- The daily decrease that no transfer explains is gas.
      CREATE TABLE IF NOT EXISTS balance_snapshots (
        taken_at   TEXT    NOT NULL,
        chain_id   INTEGER NOT NULL,
        address    TEXT    NOT NULL,
        symbol     TEXT    NOT NULL,
        quantity   TEXT    NOT NULL,
        PRIMARY KEY (taken_at, chain_id, address, symbol)
      );

      -- Cached USD prices. Only ever used to decide whether a row clears the
      -- dust threshold, so a stale price costs visibility, never correctness.
      -- Caching also keeps Spark inside CoinGecko's free rate limit, which it
      -- otherwise trips within minutes.
      CREATE TABLE IF NOT EXISTS prices (
        key        TEXT NOT NULL PRIMARY KEY,
        usd        REAL NOT NULL,
        fetched_at INTEGER NOT NULL
      );

      -- Gas spent per transaction, from the explorer's tx list. Gas leaves no
      -- log and is spent on approvals and failed transactions too, so it is
      -- otherwise invisible; without it a native balance drifts down forever
      -- with nothing explaining it.
      CREATE TABLE IF NOT EXISTS gas_costs (
        chain_id  INTEGER NOT NULL,
        tx_hash   TEXT    NOT NULL,
        address   TEXT    NOT NULL,
        block_time INTEGER NOT NULL,
        wei       TEXT    NOT NULL,
        PRIMARY KEY (chain_id, tx_hash, address)
      );

      CREATE TABLE IF NOT EXISTS runs (
        started_at TEXT NOT NULL PRIMARY KEY,
        finished_at TEXT,
        transfers_found INTEGER NOT NULL DEFAULT 0,
        note TEXT
      );
    `)
  }

  getCursor(chainId: number, address: string): number | null {
    const row = this.db
      .query<{ last_block: number }, [number, string]>(
        'SELECT last_block FROM cursors WHERE chain_id = ? AND address = ?',
      )
      .get(chainId, address.toLowerCase())
    return row?.last_block ?? null
  }

  setCursor(chainId: number, address: string, block: number): void {
    this.db.run(
      `INSERT INTO cursors (chain_id, address, last_block, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, address) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`,
      [chainId, address.toLowerCase(), block, new Date().toISOString()],
    )
  }

  /** Inserts transfers, ignoring any already captured. Returns how many were new. */
  recordTransfers(rows: TransferRow[]): number {
    if (!rows.length) return 0
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO transfers
       (chain_id, tx_hash, log_index, block_number, block_time, contract, symbol, from_addr, to_addr, raw_value, decimals)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let added = 0
    const tx = this.db.transaction((batch: TransferRow[]) => {
      for (const r of batch) {
        const res = insert.run(
          r.chainId,
          r.txHash.toLowerCase(),
          r.logIndex,
          r.blockNumber,
          r.blockTime,
          r.contract?.toLowerCase() ?? null,
          r.symbol,
          r.fromAddr.toLowerCase(),
          r.toAddr.toLowerCase(),
          r.rawValue,
          r.decimals,
        )
        added += res.changes
      }
    })
    tx(rows)
    return added
  }

  recordGas(rows: { chainId: number; txHash: string; address: string; blockTime: number; wei: string }[]): number {
    if (!rows.length) return 0
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO gas_costs (chain_id, tx_hash, address, block_time, wei) VALUES (?, ?, ?, ?, ?)',
    )
    let added = 0
    const tx = this.db.transaction(() => {
      for (const r of rows) added += insert.run(r.chainId, r.txHash.toLowerCase(), r.address.toLowerCase(), r.blockTime, r.wei).changes
    })
    tx()
    return added
  }

  recordBalances(takenAt: string, rows: { chainId: number; address: string; symbol: string; quantity: string }[]): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO balance_snapshots (taken_at, chain_id, address, symbol, quantity) VALUES (?, ?, ?, ?, ?)',
    )
    const tx = this.db.transaction(() => {
      for (const r of rows) insert.run(takenAt, r.chainId, r.address.toLowerCase(), r.symbol, r.quantity)
    })
    tx()
  }

  /** Cached prices newer than `maxAgeSeconds`. */
  cachedPrices(maxAgeSeconds: number): Map<string, number> {
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds
    const rows = this.db
      .query<{ key: string; usd: number }, [number]>('SELECT key, usd FROM prices WHERE fetched_at >= ?')
      .all(cutoff)
    return new Map(rows.map((r) => [r.key, r.usd]))
  }

  /** Last known price regardless of age — better than none for a visibility test. */
  allPrices(): Map<string, number> {
    const rows = this.db.query<{ key: string; usd: number }, []>('SELECT key, usd FROM prices').all()
    return new Map(rows.map((r) => [r.key, r.usd]))
  }

  putPrices(prices: Map<string, number>): void {
    const now = Math.floor(Date.now() / 1000)
    const insert = this.db.prepare('INSERT OR REPLACE INTO prices (key, usd, fetched_at) VALUES (?, ?, ?)')
    const tx = this.db.transaction(() => {
      for (const [key, usd] of prices) insert.run(key, usd, now)
    })
    tx()
  }

  startRun(): string {
    const startedAt = new Date().toISOString()
    this.db.run('INSERT OR REPLACE INTO runs (started_at) VALUES (?)', [startedAt])
    return startedAt
  }

  finishRun(startedAt: string, transfersFound: number, note?: string): void {
    this.db.run('UPDATE runs SET finished_at = ?, transfers_found = ?, note = ? WHERE started_at = ?', [
      new Date().toISOString(),
      transfersFound,
      note ?? null,
      startedAt,
    ])
  }

  /** Captured transfers, most recent first. */
  recentTransfers(limit = 50): (TransferRow & { postedAt: string | null })[] {
    return this.db
      .query<any, [number]>(
        `SELECT chain_id AS chainId, tx_hash AS txHash, log_index AS logIndex, block_number AS blockNumber,
                block_time AS blockTime, contract, symbol, from_addr AS fromAddr, to_addr AS toAddr,
                raw_value AS rawValue, decimals, posted_at AS postedAt
           FROM transfers ORDER BY block_time DESC, log_index DESC LIMIT ?`,
      )
      .all(limit)
  }

  stats(): { transfers: number; earliest: number | null; latest: number | null; runs: number } {
    const t = this.db
      .query<{ n: number; lo: number | null; hi: number | null }, []>(
        'SELECT COUNT(*) AS n, MIN(block_time) AS lo, MAX(block_time) AS hi FROM transfers',
      )
      .get()!
    const r = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM runs').get()!
    return { transfers: t.n, earliest: t.lo, latest: t.hi, runs: r.n }
  }

  close(): void {
    this.db.close()
  }
}
