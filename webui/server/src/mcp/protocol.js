/**
 * The Model Context Protocol, as much of it as a tools-only server needs.
 *
 * Hand-written rather than taken from the SDK: this server offers tools and
 * nothing else — no resources, no prompts, no sampling, no sessions — and that
 * subset is four JSON-RPC methods. The SDK would bring a second copy of
 * Express, ajv and an OAuth client along for them.
 *
 * Kept free of HTTP, so the tests can drive it with plain objects.
 */

/** Newest first. A client asking for one of these gets it echoed back. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

/** Tool output beyond this is cut; a model gains nothing from a 5 MB log. */
const MAX_TEXT = 200_000

export const RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
}

/** What a tool throws when the REST API answered with an error. */
export class ToolError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message)
    this.name = 'ToolError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * @param {object} opts
 * @param {Array<{name: string, title?: string, description: string, inputSchema: object,
 *   annotations?: object, run: (args: object, api: Function) => Promise<unknown>}>} opts.tools
 * @param {{name: string, version: string, title?: string}} opts.serverInfo
 * @param {string} [opts.instructions]
 * @param {(msg: string, err?: Error) => void} [opts.onError]
 * @returns {(message: unknown, api: Function) => Promise<object|null>} null for notifications
 */
export function createMcpHandler({ tools, serverInfo, instructions, onError = () => {} }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const listing = tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    ...(title ? { title } : {}),
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  }))

  const methods = {
    initialize(params) {
      const requested = params?.protocolVersion
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        ...(instructions ? { instructions } : {}),
      }
    },

    ping() {
      return {}
    },

    'tools/list'() {
      return { tools: listing }
    },

    async 'tools/call'(params, api) {
      const tool = byName.get(params?.name)
      if (!tool) throw rpcError(RPC.invalidParams, `Unbekanntes Tool: ${params?.name}`)

      const args = params.arguments ?? {}
      if (typeof args !== 'object' || Array.isArray(args)) {
        throw rpcError(RPC.invalidParams, 'arguments muss ein Objekt sein.')
      }
      // Required fields are checked here because several of them end up in a
      // URL path, where a missing one would read as "undefined" and produce a
      // confusing 404 instead of saying what is missing.
      const missing = (tool.inputSchema.required ?? []).filter(
        (key) => args[key] === undefined || args[key] === null || args[key] === '',
      )
      if (missing.length) {
        return toolFailure(`Pflichtangabe fehlt: ${missing.join(', ')}`)
      }

      try {
        return toolSuccess(await tool.run(args, api))
      } catch (err) {
        // A failed call is an answer the model should read and react to — a
        // port conflict, a model still in use — not a protocol fault. Only
        // errors from our own code are logged as such.
        if (err instanceof ToolError) return toolFailure(describe(err))
        onError(`MCP-Tool ${tool.name} fehlgeschlagen`, err)
        return toolFailure(`Interner Fehler: ${err.message}`)
      }
    },
  }

  return async function handle(message, api) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, RPC.invalidRequest, 'Erwartet wird eine JSON-RPC-Nachricht.')
    }
    const { jsonrpc, id, method, params } = message
    const isNotification = id === undefined
    if (jsonrpc !== '2.0' || typeof method !== 'string') {
      // A response from the client (to a request we never send) lands here
      // too; there is nothing to answer.
      return isNotification ? null : errorResponse(id, RPC.invalidRequest, 'Ungültige Anfrage.')
    }

    // notifications/initialized, notifications/cancelled and friends: nothing
    // to do for a server without state.
    if (isNotification) return null

    const fn = methods[method]
    if (!fn) return errorResponse(id, RPC.methodNotFound, `Unbekannte Methode: ${method}`)

    try {
      return { jsonrpc: '2.0', id, result: await fn(params, api) }
    } catch (err) {
      if (err.rpcCode) return errorResponse(id, err.rpcCode, err.message)
      onError(`MCP-Methode ${method} fehlgeschlagen`, err)
      return errorResponse(id, RPC.internalError, 'Interner Fehler.')
    }
  }
}

function rpcError(code, message) {
  const err = new Error(message)
  err.rpcCode = code
  return err
}

export function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function toolSuccess(value) {
  // Compact on purpose: indentation costs a model about a third more tokens
  // and tells it nothing.
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return { content: [{ type: 'text', text: clip(text) }], isError: false }
}

function toolFailure(text) {
  return { content: [{ type: 'text', text: clip(text) }], isError: true }
}

function describe(err) {
  const head = err.status ? `Fehler ${err.status}${err.code ? ` (${err.code})` : ''}: ` : 'Fehler: '
  // Validation details are zod issue lists — noise next to the message, which
  // already names the offending field. Everything else (the servers holding a
  // model, the probed RPC peers) is what the model needs to decide next.
  const details =
    err.details && !err.details.issues ? `\n${JSON.stringify(err.details)}` : ''
  return `${head}${err.message}${details}`
}

function clip(text) {
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT)}\n… (gekürzt, ${text.length - MAX_TEXT} Zeichen ausgelassen)`
}
