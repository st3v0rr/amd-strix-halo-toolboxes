import fs from 'node:fs'
import net from 'node:net'
import { randomBytes } from 'node:crypto'

import {
  COMFY_PORT,
  CONTAINER_PORT,
  IMAGE_REPO,
  NAME_RE,
  PORT_MAX,
  PORT_MIN,
  ROLE,
  RPC_PORT,
  SERVER_DEFAULTS,
} from '../../../shared/constants.js'
import { normalizeRpcPeers, parseRpcPeer } from '../../../shared/rpc.js'
import { badRequest, conflict, failedDependency, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { registerSecret } from '../lib/redact.js'
import { safeResolve } from '../models/paths.js'
import {
  buildComfyRunArgv,
  buildRpcRunArgv,
  buildRunArgv,
  hostModelPath,
  normalizeModelPath,
  rpcCacheVolume,
} from './argv.js'
import { buildComfyLabels, buildLabels, buildRpcLabels, parseLabels } from './labels.js'
import {
  containerExists,
  inspectContainer,
  invalidatePsCache,
  listAll,
  listManaged,
  removeContainer,
  runContainer,
  startContainer,
  stopContainer,
} from './client.js'
import { resolveExtraArgs } from './features.js'
import { closeLogSession } from './logstream.js'

/** States in which a container actually holds its published ports. */
const HOLDS_PORTS = new Set(['running', 'paused'])

/**
 * The container currently occupying `port`, or null.
 *
 * Only running (or paused) containers count. A stopped container still lists
 * its port mapping in `podman ps -a`, but the port is free — blocking on that
 * refused starts for a container the user had already shut down.
 *
 * @param {any[]} containers entries from `podman ps -a --format json`
 * @param {number} port host port
 * @param {string} [ignoreName] container we are about to replace
 */
export function findPortConflict(containers, port, ignoreName) {
  for (const entry of containers ?? []) {
    const name = (entry.Names ?? [])[0]
    if (name === ignoreName) continue
    if (!HOLDS_PORTS.has(String(entry.State ?? '').toLowerCase())) continue

    const taken = (entry.Ports ?? []).some(
      (p) => Number(p.host_port) === Number(port) && (p.protocol ?? 'tcp') === 'tcp',
    )
    if (taken) return name ?? entry.Id?.slice(0, 12) ?? 'unbekannt'
  }
  return null
}

/** Whether `ignoreName` is the one holding the port (so freeing it is imminent). */
function replacedContainerHoldsPort(containers, port, ignoreName) {
  if (!ignoreName) return false
  const entry = (containers ?? []).find((c) => (c.Names ?? [])[0] === ignoreName)
  if (!entry || !HOLDS_PORTS.has(String(entry.State ?? '').toLowerCase())) return false
  return (entry.Ports ?? []).some((p) => Number(p.host_port) === Number(port))
}

/** Shape a `podman ps` entry into what the UI needs. */
export function describeContainer(entry) {
  const labels = parseLabels(entry.Labels ?? {})
  const name = (entry.Names ?? [])[0] ?? entry.Id?.slice(0, 12) ?? 'unbekannt'
  // Each role publishes a different container port — 50052 for a worker, 8000
  // for ComfyUI, 11434 for llama-server. Looking for the wrong one would
  // silently report "kein Port" for that whole role.
  const innerPort =
    labels.role === ROLE.rpc
      ? RPC_PORT
      : labels.role === ROLE.comfy
        ? COMFY_PORT
        : CONTAINER_PORT
  const published = (entry.Ports ?? []).find((p) => p.container_port === innerPort)
  return {
    name,
    id: entry.Id,
    image: entry.Image ?? labels.image,
    state: entry.State ?? 'unknown',
    status: entry.Status ?? '',
    createdAt: entry.CreatedAt ?? labels.createdAt,
    hostPort: published?.host_port ?? labels.hostPort,
    running: entry.State === 'running',
    ...labels,
  }
}

export async function listServers() {
  const entries = await listManaged({ force: true })
  return entries.map(describeContainer).sort((a, b) => a.name.localeCompare(b.name))
}

export async function getServer(name) {
  const servers = await listServers()
  const server = servers.find((s) => s.name === name)
  if (!server) throw notFound(`Kein verwalteter Server namens '${name}'.`)
  return server
}

export async function getServerDetail(name) {
  const server = await getServer(name)
  const inspect = await inspectContainer(name)
  return {
    ...server,
    // The resolved argv is shown in the UI so the user can compare it against a
    // manual run-llama-server.sh invocation.
    command: inspect?.Config?.Cmd ?? null,
    restartPolicy: inspect?.HostConfig?.RestartPolicy?.Name ?? null,
    exitCode: inspect?.State?.ExitCode ?? null,
  }
}

/**
 * Recover the API key from a container's resolved command.
 *
 * The key is deliberately not stored in a label — labels are readable by every
 * process of this user — so the container's argv is the only place left that
 * still knows it. It is no more exposed there than it already is: the server
 * detail page shows that same argv.
 *
 * @param {string[]|null} command `Config.Cmd` from `podman inspect`
 * @returns {string} the key, or '' when the container predates it or was
 *   started by hand without one
 */
export function apiKeyFromCommand(command) {
  const argv = Array.isArray(command) ? command : []
  const at = argv.indexOf('--api-key')
  if (at === -1) return ''
  const value = argv[at + 1]
  return typeof value === 'string' ? value : ''
}

/**
 * Turn a running container back into a profile the user can save.
 *
 * Everything a profile needs is already on the container as a label, except the
 * key — see apiKeyFromCommand. Fields a container predating a given label does
 * not carry come back as the same defaults a fresh profile would have, so the
 * dialog opens on something sane rather than on nulls.
 *
 * @param {object} server a describeContainer() result, plus `command`
 * @returns {object} a body the profiles endpoint accepts
 */
export function profileFromContainer(server) {
  return {
    name: server.name,
    image: server.image ?? IMAGE_REPO,
    modelPath: server.modelPath ?? '',
    mmprojPath: server.mmprojPath ?? '',
    specType: server.specType ?? '',
    specDraftNMax: server.specDraftNMax ?? null,
    port: server.hostPort ?? CONTAINER_PORT,
    ctxSize: server.ctxSize ?? SERVER_DEFAULTS.ctxSize,
    gpuLayers: server.gpuLayers ?? SERVER_DEFAULTS.gpuLayers,
    threads: server.threads ?? SERVER_DEFAULTS.threads,
    apiKey: apiKeyFromCommand(server.command),
    extraArgs: server.extraArgs ?? '',
    rpcPeers: server.rpcPeers ?? [],
    // Never inherited: a container running now says nothing about whether the
    // user wants it back after a reboot.
    autostart: false,
  }
}

export function generateApiKey() {
  return randomBytes(16).toString('hex')
}

/**
 * Try to bind the port ourselves to see whether it is free.
 *
 * Cheaper and more truthful than parsing `ss`: it answers exactly the question
 * podman is about to ask. Anything other than a clear "in use" is treated as
 * free — a probe that fails for its own reasons must not block a start.
 *
 * @returns {Promise<string|null>} a short reason when occupied, else null
 */
export function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    const done = (result) => {
      server.removeAllListeners()
      try {
        server.close()
      } catch {
        /* already closed */
      }
      resolve(result)
    }
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') done('EADDRINUSE')
      else if (err.code === 'EACCES') done('keine Berechtigung')
      else done(null)
    })
    server.once('listening', () => done(null))
    try {
      server.listen({ port, host: '0.0.0.0', exclusive: true })
    } catch {
      done(null)
    }
  })
}

/**
 * Checks every container start shares: a usable name, a free port, an image we
 * are willing to run.
 *
 * The port checks exist because the script learned them the hard way — a taken
 * port produces a container that dies on bind, and with
 * `--restart unless-stopped` that becomes a silent loop.
 */
async function validateCommon(ctx, spec, { ignoreName } = {}) {
  const settings = ctx.settings

  if (!NAME_RE.test(spec.name ?? '')) {
    throw badRequest(
      'Ungültiger Containername. Erlaubt sind Buchstaben, Ziffern, Punkt, Unterstrich und Bindestrich (max. 63 Zeichen).',
    )
  }

  const port = Number(spec.port)
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    throw badRequest(`Der Port muss zwischen ${PORT_MIN} und ${PORT_MAX} liegen.`)
  }

  if (!settings.allowCustomImages && !spec.image.startsWith(`${IMAGE_REPO}:`)) {
    throw badRequest(
      `Nur Images aus ${IMAGE_REPO} sind erlaubt. Beliebige Images lassen sich in den Einstellungen freischalten.`,
    )
  }

  const all = await listAll()
  const blocker = findPortConflict(all, port, ignoreName)
  if (blocker) {
    throw conflict(`Port ${port} ist bereits vom laufenden Container '${blocker}' belegt.`)
  }

  // Containers are not the only thing that can hold a port. Probing catches a
  // native process too — but not when the port belongs to the very container
  // we are about to stop and replace.
  if (!replacedContainerHoldsPort(all, port, ignoreName)) {
    const occupant = await portInUse(port)
    if (occupant) {
      throw conflict(
        `Port ${port} ist bereits belegt (${occupant}), aber von keinem Container. Beende den Prozess oder wähle einen anderen Port.`,
      )
    }
  }

  return { port }
}

/**
 * Validate a llama-server start request before anything is spawned.
 *
 * On top of the common checks: a missing model file plus
 * `--restart unless-stopped` produces a silent crash loop, so the file has to
 * exist before we hand the spec to podman.
 */
export async function validateSpec(ctx, spec, { ignoreName } = {}) {
  const settings = ctx.settings
  const { port } = await validateCommon(ctx, spec, { ignoreName })

  // Path traversal guard — the same one every filesystem entry point uses.
  const rel = normalizeModelPath(spec.modelPath)
  safeResolve(settings.modelsDir, rel)

  const hostPath = hostModelPath(settings.modelsDir, rel)
  if (!fs.existsSync(hostPath)) {
    throw failedDependency(
      `Modell nicht gefunden: ${hostPath}. Ohne die Datei würde der Container in einer stillen Neustart-Schleife landen.`,
    )
  }

  // A vision model's projector gets the same treatment. Checking it here rather
  // than letting llama-server fail matters more than for the model itself: a
  // missing projector does not stop the server, it just makes every image
  // request fail later with nothing pointing at the cause.
  let mmprojRel = ''
  if (spec.mmprojPath) {
    mmprojRel = normalizeModelPath(spec.mmprojPath)
    safeResolve(settings.modelsDir, mmprojRel)
    const mmprojHostPath = hostModelPath(settings.modelsDir, mmprojRel)
    if (!fs.existsSync(mmprojHostPath)) {
      throw failedDependency(`Projektor nicht gefunden: ${mmprojHostPath}.`)
    }
  }

  return { rel, mmprojRel, hostPath, port }
}

/**
 * Can we open a TCP connection to this address?
 *
 * The only health signal an RPC worker gives from the outside — it speaks a
 * binary protocol, not HTTP, so there is no endpoint to ask.
 */
export function tcpReachable(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (result) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done({ reachable: true }))
    socket.once('timeout', () => done({ reachable: false, reason: 'Zeitüberschreitung' }))
    socket.once('error', (err) => done({ reachable: false, reason: err.code || err.message }))
    socket.connect(port, host)
  })
}

/** Probe every peer concurrently; the slowest one decides how long this takes. */
export async function probeRpcPeers(peers, timeoutMs = 2000) {
  return Promise.all(
    peers.map(async (peer) => {
      const parsed = parseRpcPeer(peer)
      if (!parsed) return { peer, reachable: false, reason: 'Ungültige Adresse' }
      const result = await tcpReachable(parsed.host, parsed.port, timeoutMs)
      return { peer, ...result }
    }),
  )
}

/**
 * Create and start a container.
 *
 * @param {object} ctx
 * @param {object} spec name, image, modelPath, port, ctxSize, gpuLayers, threads, apiKey, extraArgs, profileId
 * @param {{replace?: boolean, onLog?: (line: string) => void}} [opts]
 */
export async function createServer(ctx, spec, { replace = false, onLog = () => {} } = {}) {
  const settings = ctx.settings
  const exists = await containerExists(spec.name)
  if (exists && !replace) {
    throw conflict(
      `Ein Container namens '${spec.name}' existiert bereits.`,
      { existing: spec.name },
    )
  }

  const { rel, mmprojRel } = await validateSpec(ctx, spec, {
    ignoreName: exists ? spec.name : undefined,
  })

  // A cluster run reaches out to other machines. Check them before we start,
  // because llama-server exits when a peer refuses — and `--restart
  // unless-stopped` would turn that into the silent loop we guard against
  // everywhere else.
  const { peers: rpcPeers, invalid } = normalizeRpcPeers(spec.rpcPeers ?? [])
  if (invalid.length) {
    throw badRequest(`Ungültige RPC-Adresse: ${invalid.join(', ')}. Erwartet wird host:port.`)
  }
  if (rpcPeers.length) {
    onLog(`Prüfe ${rpcPeers.length} RPC-Knoten …`)
    const probes = await probeRpcPeers(rpcPeers)
    const dead = probes.filter((p) => !p.reachable)
    if (dead.length) {
      throw failedDependency(
        `RPC-Knoten nicht erreichbar: ${dead.map((d) => `${d.peer} (${d.reason})`).join(', ')}. ` +
          'Starte dort den RPC-Worker, bevor du den Cluster hochfährst.',
        { peers: probes },
      )
    }
    onLog(`Alle ${rpcPeers.length} RPC-Knoten erreichbar.`)
  }

  if (exists) {
    onLog(`Ersetze vorhandenen Container '${spec.name}' …`)
    closeLogSession(spec.name)
    await stopContainer(spec.name)
    await removeContainer(spec.name, { force: true })
  }

  // Empty extraArgs means "work it out from the image", exactly as the script's
  // empty EXTRA_ARGS does. An explicit value skips detection entirely.
  let extraArgs = (spec.extraArgs ?? '').trim()
  let specSupported = null
  if (!extraArgs) {
    const detected = await resolveExtraArgs(ctx, spec.image, { onLog })
    extraArgs = detected.extraArgs
    specSupported = detected.specType
  } else {
    onLog(`Nutze vorgegebene Zusatzargumente: ${extraArgs}`)
    // Detection was skipped above, but a speculative setting still needs the
    // capability answer — otherwise an old image takes the flag and dies.
    if (spec.specType) specSupported = (await resolveExtraArgs(ctx, spec.image)).specType
  }

  // Only refuse when the probe actually said the flag is missing. Unknown stays
  // permissive: an image we could not probe must not block a working setup.
  if (spec.specType && specSupported === false) {
    throw failedDependency(
      `Das Image ${spec.image} kennt --spec-type nicht, Speculative Decoding ist dort also ` +
        'nicht verfügbar. Zieh ein aktuelles Image oder stelle die Einstellung auf "Aus".',
    )
  }

  const apiKey = spec.apiKey || generateApiKey()
  registerSecret(apiKey)

  const labels = buildLabels({
    role: ROLE.server,
    profileId: spec.profileId,
    modelPath: rel,
    mmprojPath: mmprojRel,
    specType: spec.specType,
    specDraftNMax: spec.specDraftNMax,
    image: spec.image,
    ctxSize: spec.ctxSize,
    gpuLayers: spec.gpuLayers,
    threads: spec.threads,
    hostPort: spec.port,
    extraArgs,
    rpcPeers,
  })

  const argv = buildRunArgv({
    containerName: spec.name,
    image: spec.image,
    hostPort: spec.port,
    modelsDir: settings.modelsDir,
    modelPath: rel,
    mmprojPath: mmprojRel,
    specType: spec.specType,
    specDraftNMax: spec.specDraftNMax,
    ctxSize: spec.ctxSize,
    gpuLayers: spec.gpuLayers,
    threads: spec.threads,
    apiKey,
    extraArgs,
    rpcPeers,
    labels,
  })

  onLog(`Starte ${spec.name} (${spec.image}) auf Port ${spec.port} …`)
  const id = await runContainer(argv)
  log.info(`Server '${spec.name}' gestartet (${id.slice(0, 12)})`)

  return {
    name: spec.name,
    id,
    apiKey,
    extraArgs,
    mmprojPath: mmprojRel,
    specType: spec.specType ?? '',
    rpcPeers,
  }
}

/**
 * Create and start a ggml-rpc-server worker, offering this machine's GPU to a
 * llama-server running elsewhere.
 *
 * @param {object} ctx
 * @param {object} spec name, image, port, bindAddress
 * @param {{replace?: boolean, onLog?: (line: string) => void}} [opts]
 */
export async function createRpcWorker(ctx, spec, { replace = false, onLog = () => {} } = {}) {
  const exists = await containerExists(spec.name)
  if (exists && !replace) {
    throw conflict(`Ein Container namens '${spec.name}' existiert bereits.`, {
      existing: spec.name,
    })
  }

  await validateCommon(ctx, spec, { ignoreName: exists ? spec.name : undefined })

  if (exists) {
    onLog(`Ersetze vorhandenen Container '${spec.name}' …`)
    closeLogSession(spec.name)
    await stopContainer(spec.name)
    await removeContainer(spec.name, { force: true })
  }

  const labels = buildRpcLabels({ image: spec.image, hostPort: spec.port })
  const argv = buildRpcRunArgv({
    containerName: spec.name,
    image: spec.image,
    hostPort: spec.port,
    bindAddress: spec.bindAddress ?? '',
    cacheVolume: rpcCacheVolume(spec.name),
    labels,
  })

  onLog(`Starte RPC-Worker ${spec.name} (${spec.image}) auf Port ${spec.port} …`)
  const id = await runContainer(argv)
  log.info(`RPC-Worker '${spec.name}' gestartet (${id.slice(0, 12)})`)

  return { name: spec.name, id, role: ROLE.rpc, port: spec.port }
}

/**
 * Create and start a ComfyUI container.
 *
 * Much smaller than createServer: the image starts ComfyUI on its own, with the
 * flags baked into toolboxes_comfyui/Dockerfile.comfyui. There is no model to
 * pick — ComfyUI loads whatever a workflow asks for from the mounted directory
 * — and so nothing to detect at the image either.
 *
 * The two host directories are created if missing. Podman would create them
 * too, but as root-owned directories that the user then cannot write to.
 */
export async function createComfyServer(ctx, spec, { replace = false, onLog = () => {} } = {}) {
  const settings = ctx.settings
  const exists = await containerExists(spec.name)
  if (exists && !replace) {
    throw conflict(`Ein Container namens '${spec.name}' existiert bereits.`, {
      existing: spec.name,
    })
  }

  await validateCommon(ctx, spec, { ignoreName: exists ? spec.name : undefined })

  const modelsDir = settings.comfyModelsDir
  const outputDir = settings.comfyOutputDir
  for (const dir of [modelsDir, outputDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      throw failedDependency(`Verzeichnis ${dir} lässt sich nicht anlegen: ${err.message}`)
    }
  }

  if (exists) {
    onLog(`Ersetze vorhandenen Container '${spec.name}' …`)
    closeLogSession(spec.name)
    await stopContainer(spec.name)
    await removeContainer(spec.name, { force: true })
  }

  const labels = buildComfyLabels({
    image: spec.image,
    hostPort: spec.port,
    modelsDir,
    outputDir,
  })
  const argv = buildComfyRunArgv({
    containerName: spec.name,
    image: spec.image,
    hostPort: spec.port,
    modelsDir,
    outputDir,
    labels,
  })

  onLog(`Starte ComfyUI ${spec.name} (${spec.image}) auf Port ${spec.port} …`)
  const id = await runContainer(argv)
  log.info(`ComfyUI '${spec.name}' gestartet (${id.slice(0, 12)})`)

  return { name: spec.name, id, role: ROLE.comfy, port: spec.port, modelsDir, outputDir }
}

export async function startServer(name) {
  await getServer(name)
  await startContainer(name)
  return getServer(name)
}

export async function stopServer(name) {
  await getServer(name)
  await stopContainer(name)
  return getServer(name)
}

export async function restartServer(name) {
  await stopServer(name)
  return startServer(name)
}

export async function deleteServer(name) {
  await getServer(name)
  closeLogSession(name)
  await stopContainer(name)
  await removeContainer(name, { force: true })
  invalidatePsCache()
  return { removed: name }
}

/**
 * Ask a running llama-server whether it is ready.
 *
 * The target is always 127.0.0.1 on a port taken from our own labels — never
 * from user input — so this cannot be turned into a general-purpose proxy.
 */
export async function serverHealth(name) {
  const server = await getServer(name)
  if (!server.running) return { reachable: false, state: server.state }
  if (!server.hostPort) return { reachable: false, reason: 'Kein veröffentlichter Port.' }

  // An RPC worker speaks a binary protocol — there is no /health to ask. That
  // the port accepts a connection is the whole signal available.
  if (server.role === ROLE.rpc) {
    const result = await tcpReachable('127.0.0.1', server.hostPort)
    return { ...result, role: ROLE.rpc }
  }

  // ComfyUI has no health endpoint either, but it does serve its own UI, and a
  // model loading for minutes still answers there. /system_stats is the
  // cheapest honest signal it offers.
  if (server.role === ROLE.comfy) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const res = await fetch(`http://127.0.0.1:${server.hostPort}/system_stats`, {
        signal: controller.signal,
      })
      return { reachable: res.ok, status: res.status, role: ROLE.comfy }
    } catch (err) {
      return { reachable: false, reason: err.name === 'AbortError' ? 'Zeitüberschreitung' : err.message, role: ROLE.comfy }
    } finally {
      clearTimeout(timer)
    }
  }

  // For a cluster head, report each peer alongside its own health: the head
  // being up says nothing about whether it still has all its GPUs.
  const peers = server.rpcPeers?.length ? await probeRpcPeers(server.rpcPeers) : []

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(`http://127.0.0.1:${server.hostPort}/health`, {
      signal: controller.signal,
    })
    const body = await res.text()
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = { raw: body.slice(0, 200) }
    }
    return { reachable: true, status: res.status, body: parsed, peers }
  } catch (err) {
    return {
      reachable: false,
      reason: err.name === 'AbortError' ? 'Zeitüberschreitung' : err.message,
      peers,
    }
  } finally {
    clearTimeout(timer)
  }
}
