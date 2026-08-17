/**
 * Builds the address book from Wealthfolio's own database.
 *
 * Reading the database is deliberately limited to this one lookup. Wealthfolio's
 * valuation engine turns activities into holdings, so anything written behind the
 * API is inert; and a second writer on a WAL database risks corruption. Reading a
 * field the API declines to expose carries neither of those costs.
 *
 * The connection is opened strictly read-only. Note that SQLite needs to read the
 * -wal and -shm sidecars to see committed data, so a container mount must include
 * the whole data directory, not just the .db file.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { ADDRESS_OVERRIDES, VENUES, type WalletAccount } from './config'

type AccountRow = { id: string; name: string; account_number: string | null }

export type AddressBookIssue = { account: string; problem: string }

export type AddressBook = {
  accounts: WalletAccount[]
  issues: AddressBookIssue[]
}

/**
 * Address book from configuration alone, for when Wealthfolio's database is not
 * reachable. Chain scanning needs only addresses; the account ids it cannot
 * supply are blank, so anything comparing against Wealthfolio must not use this.
 */
function configOnlyBook(): AddressBook {
  // An empty book would make every report succeed with nothing in it, which
  // reads exactly like "everything reconciles". Fail loudly instead.
  if (!Object.keys(VENUES).length) {
    throw new Error(
      'No wallets configured: set SPARK_WALLETS="name:venue:address,…" ' +
        '(venue is evm | safe | hyperliquid), or point SPARK_WF_DB_PATH at the Wealthfolio database.',
    )
  }

  const accounts: WalletAccount[] = []
  const issues: AddressBookIssue[] = [
    { account: '(all)', problem: 'Wealthfolio database unavailable — using configured addresses only' },
  ]
  for (const [name, venue] of Object.entries(VENUES)) {
    const address = ADDRESS_OVERRIDES[name]
    if (address) accounts.push({ name, venue, address, accountId: '' })
    else issues.push({ account: name, problem: 'no configured address' })
  }
  return { accounts, issues }
}

export function loadAddressBook(dbPath: string): AddressBook {
  if (!existsSync(dbPath)) return configOnlyBook()
  const db = new Database(dbPath, { readonly: true })
  try {
    const rows = db
      .query<AccountRow, []>(
        `SELECT id, name, account_number
           FROM accounts
          WHERE is_active = 1 AND is_archived = 0`,
      )
      .all()

    const byName = new Map(rows.map((r) => [r.name, r]))
    const accounts: WalletAccount[] = []
    const issues: AddressBookIssue[] = []

    for (const [name, venue] of Object.entries(VENUES)) {
      const row = byName.get(name)
      if (!row) {
        // A rename in Wealthfolio must fail loudly: silently dropping the account
        // would report zero drift for it forever.
        issues.push({ account: name, problem: 'not found in Wealthfolio — renamed or archived?' })
        continue
      }

      const address = row.account_number?.trim() || ADDRESS_OVERRIDES[name]
      if (!address) {
        issues.push({ account: name, problem: 'no account_number and no configured override' })
        continue
      }

      if (row.account_number?.trim() && ADDRESS_OVERRIDES[name]) {
        // Wealthfolio has since been filled in; the override is now redundant and
        // could drift away from the real value.
        issues.push({
          account: name,
          problem: 'account_number is now set — remove the override in config.ts',
        })
      }

      accounts.push({ name, venue, address, accountId: row.id })
    }

    return { accounts, issues }
  } finally {
    db.close()
  }
}
