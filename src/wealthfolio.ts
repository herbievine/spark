/**
 * Wealthfolio client, over MCP rather than REST.
 *
 * The Personal Access Token authenticates the MCP endpoint at /mcp only — the
 * REST API under /api/v1 rejects it with 401 in every header shape and accepts
 * nothing but the `wf_session` cookie. MCP is therefore the whole read surface,
 * and it is a fixed tool catalog rather than a view onto REST: notably
 * `get_accounts` cannot return `account_number`.
 */

const PROTOCOL_VERSION = '2025-06-18'

export type Holding = {
  symbol: string
  name: string
  quantity: number
  holdingType: string
}

/** Parses an SSE body, returning the first JSON-RPC payload it carries. */
function parseSse(body: string): any {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (!payload) continue
    return JSON.parse(payload)
  }
  throw new Error(`no JSON-RPC payload in SSE response: ${body.slice(0, 200)}`)
}

export class Wealthfolio {
  private sessionId?: string
  private nextId = 1

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      // The server replies over SSE; omitting text/event-stream earns a 406.
      accept: 'application/json, text/event-stream',
    }
    if (this.sessionId) h['mcp-session-id'] = this.sessionId
    return h
  }

  /** Performs the MCP handshake. Must run before any tool call. */
  async connect(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'spark', version: '0.1' },
        },
      }),
    })
    if (!res.ok) throw new Error(`MCP initialize failed: ${res.status} ${await res.text()}`)

    const sessionId = res.headers.get('mcp-session-id')
    if (!sessionId) throw new Error('MCP initialize returned no mcp-session-id')
    this.sessionId = sessionId
    await res.text()

    // The server rejects tool calls until it has seen this notification.
    await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
  }

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.sessionId) throw new Error('call() before connect()')

    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    if (!res.ok) throw new Error(`${name} failed: ${res.status} ${await res.text()}`)

    const rpc = parseSse(await res.text())
    if (rpc.error) throw new Error(`${name} returned an error: ${JSON.stringify(rpc.error)}`)

    // Tool results arrive as a JSON document inside a text content block.
    const text = rpc.result?.content?.[0]?.text
    if (typeof text !== 'string') throw new Error(`${name} returned no text content`)
    return JSON.parse(text) as T
  }

  /**
   * Any MCP tool by name, for the operations that have no typed wrapper here —
   * importing and deleting activities, which run from a script rather than from
   * the tracking loop.
   */
  async tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>(name, args)
  }

  async getAccounts(): Promise<{ id: string; name: string; currency: string }[]> {
    const res = await this.call<{ accounts: any[] }>('get_accounts')
    return res.accounts
  }

  async getHoldings(accountId: string): Promise<Holding[]> {
    const res = await this.call<{ holdings: any[] }>('get_holdings', { accountId })
    return (res.holdings ?? []).map((h) => ({
      symbol: h.symbol,
      name: h.name,
      quantity: h.quantity,
      holdingType: h.holdingType,
    }))
  }

  /**
   * Cash for one account, in that account's own currency — not the portfolio
   * base currency, which would drag an FX rate into a comparison against a chain
   * balance already denominated in USD.
   */
  async getCash(accountId: string): Promise<number> {
    const res = await this.call<{ accounts: { totalAccountCurrency: number }[] }>('get_cash_balances', {
      accountId,
    })
    const account = res.accounts?.[0]
    if (!account) throw new Error(`no cash balance returned for account ${accountId}`)
    return account.totalAccountCurrency
  }
}
