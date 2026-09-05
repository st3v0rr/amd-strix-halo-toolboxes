import express from 'express'
import { z } from 'zod'

import { COMFY_PORT, PORT_MAX, PORT_MIN, ROLE, RPC_PORT } from '../../../shared/constants.js'
import { conflict } from '../lib/errors.js'
import { q, validate } from '../lib/validate.js'
import { listServers } from '../podman/servers.js'
import {
  addRichRule,
  closePort,
  firewallStatus,
  openPort,
  removeRichRule,
} from '../system/firewall.js'
import { readNetwork } from '../system/network.js'

const portBody = z.object({
  port: z.coerce.number().int().min(PORT_MIN).max(PORT_MAX),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
})

const portQuery = portBody

const ruleBody = portBody.extend({
  // Shape-checked here, meaning-checked in shared/firewall.js, which is also
  // what builds the rule string.
  source: z.string().min(7).max(18),
})

const rawQuery = z.object({ rule: z.string().min(10).max(400) })

const unmanaged = (port, protocol) =>
  `Port ${port}/${protocol} gehört zu keinem verwalteten Dienst. Solche Regeln stammen ` +
  'von woanders und werden hier nicht angefasst — von Hand ändern mit ' +
  `firewall-cmd --remove-port=${port}/${protocol}`

/**
 * Which ports this machine needs open, derived rather than configured.
 *
 * The app already knows all of them: its own port from the settings, one per
 * llama-server, one per RPC worker. Deriving the list means a server started
 * five minutes ago shows up here without anybody maintaining a second list —
 * and a port that is open for a server that no longer exists shows up as
 * exactly that.
 */
const DETAIL = {
  rpc:
    'ggml-rpc-server kennt keine Authentifizierung — wer diesen Port erreicht, kann die ' +
    'GPU dieser Maschine benutzen und beliebige Dateien lesen. Nur in einem ' +
    'vertrauenswürdigen Netz öffnen.',
  comfy:
    'ComfyUI kennt keine Anmeldung — wer diesen Port erreicht, kann Workflows ausführen ' +
    'und damit Dateien auf dieser Maschine lesen und schreiben. Nur in einem ' +
    'vertrauenswürdigen Netz öffnen.',
  server: 'llama-server, geschützt durch seinen API-Key.',
}

/** Ports without authentication. The UI warns harder for these. */
const UNAUTHENTICATED = new Set(['rpc', 'comfy'])

/** What a container's port is for, by role. */
function describeRole(server) {
  if (server.role === ROLE.rpc) {
    return { purpose: `RPC-Worker '${server.name}'`, detail: DETAIL.rpc, kind: 'rpc' }
  }
  if (server.role === ROLE.comfy) {
    return { purpose: `ComfyUI '${server.name}'`, detail: DETAIL.comfy, kind: 'comfy' }
  }
  return { purpose: `Server '${server.name}'`, detail: DETAIL.server, kind: 'server' }
}

async function requiredPorts(ctx, firewall) {
  const open = firewall.ports ?? []
  const isOpen = (port) => open.includes(`${port}/tcp`)
  // A port let through for one network only counts as open for that network,
  // not as closed — which is exactly how the RPC port is meant to be set up.
  const sourcesFor = (port, protocol) =>
    (firewall.richRules ?? [])
      .filter((rule) => rule.port === port && rule.protocol === protocol)
      .map((rule) => ({ source: rule.source, raw: rule.raw }))

  const ports = [
    {
      port: ctx.settings.port,
      protocol: 'tcp',
      purpose: 'Webinterface',
      detail: 'Diese Oberfläche. Ohne Freigabe ist sie nur lokal erreichbar.',
      kind: 'webui',
      open: isOpen(ctx.settings.port),
      sources: sourcesFor(ctx.settings.port, 'tcp'),
    },
  ]

  for (const server of await listServers()) {
    const port = Number(server.hostPort)
    if (!Number.isInteger(port)) continue
    ports.push({
      port,
      protocol: 'tcp',
      ...describeRole(server),
      running: server.running,
      open: isOpen(port),
      sources: sourcesFor(port, 'tcp'),
    })
  }

  // These two belong on the list even with nothing running: their rules are what
  // a machine is prepared with, usually before the container is ever started,
  // and without the entries an existing rule would look like a stray.
  for (const fallback of [
    { port: RPC_PORT, purpose: 'RPC-Worker (Standardport)', kind: 'rpc' },
    { port: COMFY_PORT, purpose: 'ComfyUI (Standardport)', kind: 'comfy' },
  ]) {
    if (ports.some((p) => p.port === fallback.port)) continue
    ports.push({
      port: fallback.port,
      protocol: 'tcp',
      purpose: fallback.purpose,
      detail: DETAIL[fallback.kind],
      kind: fallback.kind,
      running: false,
      open: isOpen(fallback.port),
      sources: sourcesFor(fallback.port, 'tcp'),
    })
  }

  // One firewall rule per port, however many containers claim it. A stopped
  // server and its replacement share a port routinely, and two rows for one
  // rule would mean two buttons doing the same thing.
  const merged = new Map()
  for (const entry of ports) {
    const key = `${entry.port}/${entry.protocol}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, entry)
      continue
    }
    existing.purpose = `${existing.purpose}, ${entry.purpose}`
    existing.running = existing.running || entry.running
    // A service without authentication outranks a protected one on a shared
    // port: the stronger warning is the one that has to be shown.
    if (UNAUTHENTICATED.has(entry.kind)) {
      existing.kind = entry.kind
      existing.detail = entry.detail
    }
  }
  // Ascending by port: the list is read to find a number, and insertion order
  // put the standing entries last however small their port.
  return [...merged.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol))
}

export function networkRoutes(ctx) {
  const router = express.Router()

  router.get('/', async (req, res, next) => {
    try {
      const [interfaces, firewall] = await Promise.all([readNetwork(), firewallStatus()])
      const ports = await requiredPorts(ctx, firewall)

      // Rules that belong to nothing we manage — SSH being the obvious one.
      // Shown, never touched: a button that can close port 22 is a button that
      // can end the session it was clicked in.
      const known = new Set(ports.map((p) => `${p.port}/${p.protocol}`))
      const others = (firewall.ports ?? []).filter((spec) => !known.has(spec))
      const otherRules = [
        ...(firewall.richRules ?? [])
          .filter((rule) => !known.has(`${rule.port}/${rule.protocol}`))
          .map((rule) => rule.raw),
        ...(firewall.foreignRichRules ?? []),
      ]

      res.json({ interfaces, firewall, ports, others, otherRules })
    } catch (err) {
      next(err)
    }
  })

  router.post('/firewall/ports', validate({ body: portBody }), async (req, res, next) => {
    try {
      res.json(await openPort(req.body.port, req.body.protocol))
    } catch (err) {
      next(err)
    }
  })

  /**
   * Closing is restricted to ports this app knows about. Everything else on the
   * box was opened by somebody for a reason we cannot see from here.
   */
  /**
   * Open a port for one source network instead of for everyone.
   *
   * The RPC port is the reason: it has no authentication of its own, so the
   * firewall is what keeps it to the cluster.
   */
  router.post('/firewall/rules', validate({ body: ruleBody }), async (req, res, next) => {
    try {
      const { port, protocol, source } = req.body
      const firewall = await firewallStatus()
      const ports = await requiredPorts(ctx, firewall)
      if (!ports.some((p) => p.port === port && p.protocol === protocol)) {
        throw conflict(unmanaged(port, protocol))
      }
      res.json(await addRichRule({ port, protocol, source }))
    } catch (err) {
      next(err)
    }
  })

  router.delete('/firewall/rules', validate({ query: rawQuery }), async (req, res, next) => {
    try {
      res.json(await removeRichRule({ raw: q(req).rule }))
    } catch (err) {
      next(err)
    }
  })

  router.delete('/firewall/ports', validate({ query: portQuery }), async (req, res, next) => {
    try {
      const { port, protocol } = q(req)
      const firewall = await firewallStatus()
      const ports = await requiredPorts(ctx, firewall)
      if (!ports.some((p) => p.port === port && p.protocol === protocol)) {
        throw conflict(unmanaged(port, protocol))
      }
      res.json(await closePort(port, protocol))
    } catch (err) {
      next(err)
    }
  })

  return router
}
