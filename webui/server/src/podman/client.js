import { run, stream } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { managedFilter } from './labels.js'

/** `podman ps` output changes rarely; a short cache absorbs UI polling. */
const PS_CACHE_MS = 2000
let psCache = { at: 0, value: null }

function parseJson(stdout, fallback) {
  const text = stdout.trim()
  if (!text) return fallback
  try {
    return JSON.parse(text)
  } catch (err) {
    log.warn(`podman-Ausgabe war kein gültiges JSON: ${err.message}`)
    return fallback
  }
}

/**
 * All containers this app manages, running or not.
 *
 * `--filter label=...` is what keeps us out of the way of containers the user
 * started by hand with run-llama-server.sh.
 */
export async function listManaged({ force = false } = {}) {
  if (!force && psCache.value && Date.now() - psCache.at < PS_CACHE_MS) return psCache.value
  const { stdout } = await run('podman', [
    'ps',
    '-a',
    '--filter',
    managedFilter,
    '--format',
    'json',
  ])
  const value = parseJson(stdout, [])
  psCache = { at: Date.now(), value }
  return value
}

/** Every container, so we can warn about name and port collisions. */
export async function listAll() {
  const { stdout } = await run('podman', ['ps', '-a', '--format', 'json'])
  return parseJson(stdout, [])
}

export function invalidatePsCache() {
  psCache = { at: 0, value: null }
}

export async function inspectContainer(name) {
  const { stdout, code } = await run('podman', ['inspect', name, '--format', 'json'], {
    allowFailure: true,
  })
  if (code !== 0) return null
  const parsed = parseJson(stdout, [])
  return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed
}

/**
 * `podman create`, then a look at what it will mount; the caller starts it.
 * Bind sources are resolved at start, so the check belongs between the two:
 * a directory swapped after the last check is refused here and the container
 * is removed without ever running.
 *
 * @param {string[]} argv a `run -d …` or `run --rm …` argv
 * @param {(mounts: object[]) => void} verify throws to refuse
 * @returns {Promise<string>} the container id
 */
export async function createVerified(argv, verify) {
  const rest = argv.slice(1)
  if (rest[0] === '-d') rest.shift()
  const { stdout } = await run('podman', ['create', ...rest], { timeoutMs: 120_000 })
  invalidatePsCache()
  const id = stdout.trim().split('\n').pop()
  try {
    const info = await inspectContainer(id)
    verify(info?.Mounts ?? [])
  } catch (err) {
    await removeContainer(id, { force: true })
    throw err
  }
  return id
}

/**
 * Re-inspect and verify synchronously in the same helper that invokes start.
 * The verifier also requires every configurable source component to be owned
 * by this UID/root and not group/world-writable. Consequently no in-scope
 * cross-user/group actor can change the path in the small spawn window; only
 * this UID (out of scope) or root (trusted) can do so.
 */
export async function startVerifiedContainer(name, verify, { attach = false } = {}) {
  const info = await inspectContainer(name)
  verify(info?.Mounts ?? [], info)
  const argv = ['start']
  if (attach) argv.push('--attach')
  argv.push(name)
  const result = await run('podman', argv, {
    timeoutMs: attach ? 90_000 : 60_000,
    allowFailure: attach,
  })
  invalidatePsCache()
  return result
}

/** Streaming counterpart for long-running attached one-shot containers. */
export async function streamVerifiedContainer(name, verify, options) {
  const info = await inspectContainer(name)
  verify(info?.Mounts ?? [])
  return stream('podman', ['start', '--attach', name], options)
}

export async function runContainer(argv) {
  const { stdout } = await run('podman', argv, { timeoutMs: 120_000 })
  invalidatePsCache()
  return stdout.trim()
}

export async function startContainer(name) {
  await run('podman', ['start', name], { timeoutMs: 60_000 })
  invalidatePsCache()
}

export async function stopContainer(name, timeoutSeconds = 30) {
  // llama-server can take a while to unmap a large model; give podman its own
  // grace period plus headroom before our exec timeout fires.
  await run('podman', ['stop', '-t', String(timeoutSeconds), name], {
    timeoutMs: (timeoutSeconds + 15) * 1000,
    allowFailure: true,
  })
  invalidatePsCache()
}

export async function removeContainer(name, { force = false } = {}) {
  const argv = ['rm']
  if (force) argv.push('-f')
  argv.push(name)
  await run('podman', argv, { timeoutMs: 60_000, allowFailure: true })
  invalidatePsCache()
}

export async function containerExists(name) {
  const all = await listAll()
  return all.some((c) => (c.Names ?? []).includes(name))
}

export async function listImages() {
  const { stdout } = await run('podman', ['images', '--format', 'json'])
  return parseJson(stdout, [])
}

export async function imageId(ref) {
  const { stdout, code } = await run(
    'podman',
    ['image', 'inspect', '--format', '{{.Id}}', ref],
    { allowFailure: true },
  )
  return code === 0 ? stdout.trim() : null
}

export async function imageDigest(ref) {
  const { stdout, code } = await run(
    'podman',
    ['image', 'inspect', '--format', '{{.Digest}}', ref],
    { allowFailure: true },
  )
  return code === 0 ? stdout.trim() : null
}

export async function removeImage(ref) {
  await run('podman', ['image', 'rm', ref], { timeoutMs: 60_000 })
}

/** Live resource usage for the named containers. Comparatively expensive. */
export async function containerStats(names) {
  if (!names.length) return []
  const { stdout, code } = await run(
    'podman',
    ['stats', '--no-stream', '--format', 'json', ...names],
    { timeoutMs: 15_000, allowFailure: true },
  )
  if (code !== 0) return []
  return parseJson(stdout, [])
}

/**
 * Follow a container's logs. Returns the child so the caller can kill it when
 * the last SSE client goes away.
 */
export function followLogs(name, { tail = 500, onLine, onExit }) {
  return stream('podman', ['logs', '-f', '--tail', String(tail), name], {
    onStdout: onLine,
    onStderr: onLine,
    onExit,
  })
}

/** Snapshot of the last `tail` log lines. */
export async function logSnapshot(name, tail = 500) {
  const { stdout, stderr } = await run(
    'podman',
    ['logs', '--tail', String(tail), name],
    { timeoutMs: 20_000, allowFailure: true },
  )
  // llama-server writes to stderr; podman keeps the streams separate.
  return `${stderr}${stdout}`.split(/\r\n|\r|\n/).filter(Boolean)
}
