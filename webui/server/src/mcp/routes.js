import os from 'node:os'

import express from 'express'

import { bearerFrom } from '../auth/apitoken.js'
import { requireAuth } from '../auth/middleware.js'
import { forbidden, unauthorized } from '../lib/errors.js'
import { RPC, ToolError, createMcpHandler, errorResponse } from './protocol.js'
import { instructions, tools } from './tools.js'

/** Long enough for a server start that first probes its image for arguments. */
const LOOPBACK_TIMEOUT_MS = 10 * 60_000

/**
 * The MCP endpoint: Streamable HTTP, stateless, JSON responses only.
 *
 * Stateless means no `Mcp-Session-Id` and no server-to-client stream — every
 * POST carries one message and gets its answer in the response body. GET, which
 * a client uses to open such a stream, is refused with 405, as the transport
 * spec allows.
 *
 * Only a bearer token gets in, never the browser cookie: this endpoint takes a
 * plain JSON POST, and keeping cookies out of it means it needs no CSRF story
 * of its own.
 */
export function mcpRoutes(ctx) {
  const router = express.Router()
  const auth = requireAuth(ctx.getConfig)
  const handle = createMcpHandler({
    tools,
    instructions,
    serverInfo: { name: 'strix-halo-webui', title: `Strix Halo (${os.hostname()})`, version: '0.1.0' },
    onError: (msg, err) => ctx.log.warn(msg, err),
  })

  router.use(express.json({ limit: '1mb' }))
  // Mounted ahead of the app-wide JSON parser, so a malformed body lands here
  // and can be answered in JSON-RPC's own terms.
  router.use((err, req, res, next) => {
    if (err.type !== 'entity.parse.failed') return next(err)
    res.status(400).json(errorResponse(null, RPC.parseError, 'Ungültiges JSON.'))
  })

  router.post('/', rejectForeignOrigin, bearerOnly, auth, async (req, res, next) => {
    try {
      const api = loopbackApi(ctx.selfUrl, req.get('authorization'))
      const body = req.body

      // Batches were dropped from the protocol in 2025-06-18, but an older
      // client may still send one, and answering it costs a map().
      if (Array.isArray(body)) {
        const replies = (await Promise.all(body.map((m) => handle(m, api)))).filter(Boolean)
        return replies.length ? res.json(replies) : res.status(202).end()
      }

      const reply = await handle(body, api)
      return reply ? res.json(reply) : res.status(202).end()
    } catch (err) {
      next(err)
    }
  })

  router.all('/', (req, res) => {
    res
      .set('Allow', 'POST')
      .status(405)
      .json(errorResponse(null, RPC.invalidRequest, 'Dieser MCP-Server spricht nur POST (zustandslos, ohne Stream).'))
  })

  return router
}

/**
 * The transport spec asks servers to check Origin against DNS rebinding. The
 * token already rules that out, but a browser page talking to us is never a
 * legitimate client, so saying no costs nothing.
 */
function rejectForeignOrigin(req, res, next) {
  const origin = req.get('origin')
  if (!origin) return next()
  let host
  try {
    host = new URL(origin).host
  } catch {
    return next(forbidden('Origin-Header ist unlesbar.'))
  }
  return host === req.get('host') ? next() : next(forbidden('Fremde Origin für den MCP-Endpunkt.'))
}

function bearerOnly(req, res, next) {
  if (bearerFrom(req)) return next()
  return next(
    unauthorized(
      'Der MCP-Endpunkt braucht einen API-Token (Authorization: Bearer …). Erzeugen lässt er sich unter Einstellungen → MCP-Zugang.',
    ),
  )
}

/**
 * Call our own REST API over loopback, with the caller's token.
 *
 * Over HTTP rather than by calling route internals: the routes carry their
 * validation and their refusals inline, and going through the front door is
 * what guarantees an agent meets every one of them.
 *
 * @param {string} baseUrl e.g. http://127.0.0.1:8420
 * @param {string} authorization the caller's Authorization header, verbatim
 */
export function loopbackApi(baseUrl, authorization) {
  if (!baseUrl) throw new Error('Loopback-Adresse ist noch nicht bekannt.')
  return async (method, path, { query, body } = {}) => {
    const url = new URL(`/api${path}`, baseUrl)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    const headers = { Accept: 'application/json', Authorization: authorization }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
    })

    const text = await res.text()
    let payload = null
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = { error: { code: 'bad_response', message: text.slice(0, 400) } }
      }
    }
    if (!res.ok) {
      const err = payload?.error ?? {}
      throw new ToolError(err.message || `Anfrage fehlgeschlagen (${res.status})`, {
        status: res.status,
        code: err.code,
        details: err.details,
      })
    }
    return payload
  }
}

/**
 * Where to reach ourselves, from the address the server actually bound.
 * A wildcard bind is reachable on loopback; a specific one only on itself.
 *
 * @param {import('node:net').AddressInfo} address
 */
export function loopbackUrl({ address, port, family }) {
  if (address === '0.0.0.0') return `http://127.0.0.1:${port}`
  if (address === '::') return `http://[::1]:${port}`
  const v6 = family === 'IPv6' || family === 6
  return v6 ? `http://[${address}]:${port}` : `http://${address}:${port}`
}
