import fsp from 'node:fs/promises'

import { z } from 'zod'

import { MEDIA_CONTAINER_MODELS_DIR, ROLE } from '../../../shared/constants.js'
import { AppError, failedDependency } from '../lib/errors.js'
import { run } from '../lib/exec.js'
import { redact } from '../lib/redact.js'
import { buildMediaCheckArgv, buildMediaExecCheckArgv } from '../podman/argv.js'
import { createVerified, imageId, startVerifiedContainer } from '../podman/client.js'
import { listServers } from '../podman/servers.js'
import {
  assertMediaImageAllowed,
  assertMediaPodmanRuntime,
  checkMediaDir,
  mediaModelsDir,
  pinMediaDir,
  verifyMediaMounts,
} from './config.js'

/** Long enough to absorb a page's polling, short enough to notice a manual copy. */
const CACHE_MS = 15_000

let cache = { key: null, at: 0, value: null }

export function invalidateMediaInventory() {
  cache = { key: null, at: 0, value: null }
}

const profileSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    status: z.string(),
    description: z.string().default(''),
    reason: z.string().nullable().default(null),
    tasks: z.array(z.string()),
    estimated_memory_gb: z.number(),
    lora: z.string().nullable().default(null),
    default: z.boolean().default(false),
    available: z.boolean().optional(),
    missing: z.array(z.string()).optional(),
    tasks_available: z.record(z.boolean()).optional(),
    downloadable: z.boolean().optional(),
  })
  .passthrough()

/** The `check --json` document, version 1. Validated: it comes out of a container. */
export const inventorySchema = z.object({
  version: z.literal(1),
  models_dir: z.string(),
  models: z.array(
    z
      .object({
        id: z.string(),
        label: z.string(),
        provider: z.string(),
        description: z.string().default(''),
        license: z.string().default(''),
        tasks: z.array(z.string()),
        default_profile: z.string(),
        profiles: z.array(profileSchema),
      })
      .passthrough(),
  ),
})

/**
 * Parse what `media-api-models check --json` printed. Only the document is
 * trusted, and only in the shape above.
 */
export function parseInventory(stdout) {
  const text = String(stdout ?? '').trim()
  const start = text.indexOf('{')
  let doc
  try {
    doc = JSON.parse(start >= 0 ? text.slice(start) : text)
  } catch {
    throw new AppError(502, 'bad_inventory', 'media-api-models check lieferte kein JSON.')
  }
  const result = inventorySchema.safeParse(doc)
  if (!result.success) {
    throw new AppError(502, 'bad_inventory', 'media-api-models check lieferte eine unbekannte Form.')
  }
  return result.data
}

/**
 * Turn a failed check into something a person can act on. The two cases that
 * are not a bug: an image from before `--json` existed, and one whose CLI
 * still insisted on a key.
 */
export function explainCheckFailure(code, stdout, stderr) {
  const text = `${stderr}\n${stdout}`
  if (/unrecognized arguments: --json/.test(text) || /MEDIA_API_KEY is not set/.test(text)) {
    return failedDependency(
      'Dieses Media-API-Image ist älter als die Modellübersicht des Webinterfaces. Lade oder baue das Image neu.',
    )
  }
  const detail = text.trim().split('\n').filter(Boolean).slice(-3).join(' · ')
  return new AppError(
    502,
    'check_failed',
    `media-api-models check endete mit Status ${code}${detail ? `: ${redact(detail)}` : ''}`,
  )
}

/**
 * Which models and profiles the service knows, and which of their files are
 * on disk — answered by the image's own registry, not by a copy of it.
 *
 * With the service running the check runs inside it (`podman exec`), so it
 * sees exactly the mounts and MEDIA_CONFIG the service has. Otherwise a
 * throwaway container of the configured image checks the configured tree,
 * without network, GPU or secrets.
 */
export async function mediaInventory(ctx, { force = false } = {}) {
  const config = ctx.media.data
  const runtimeMode = await assertMediaPodmanRuntime(config)
  assertMediaImageAllowed(ctx, config.image)
  // Canonical and checked like any other mount source, even read-only.
  const modelsDir = checkMediaDir('Das Modellverzeichnis', mediaModelsDir(ctx, config))
  const server = (await listServers()).find((s) => s.role === ROLE.media && s.name === config.name)
  // The inventory always describes the saved settings: they are what a fetch
  // writes to and what the next apply starts. The running container answers
  // only when it runs on that same image and tree; otherwise the page learns
  // what it runs on instead.
  const running = server?.running ? { image: server.image, modelsDir: server.mediaModelsDir } : null
  const current = Boolean(running && running.image === config.image && running.modelsDir === modelsDir)

  let argv
  let source
  if (current) {
    argv = buildMediaExecCheckArgv(server.name)
    source = 'container'
  } else {
    if (!(await imageId(config.image))) {
      throw failedDependency(
        `Das Image ${config.image} liegt nicht lokal vor — ohne es lässt sich nicht prüfen, welche Modelle es kennt. Lade es unter „Images“.`,
      )
    }
    argv = buildMediaCheckArgv({ image: config.image, modelsDir, runtimeMode })
    source = 'image'
  }

  const key = JSON.stringify(argv)
  if (!force && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value

  let result
  if (source === 'container') {
    result = await run('podman', argv, { timeoutMs: 90_000, allowFailure: true })
  } else {
    // The throwaway gets only the approved image and only the checked tree.

    const pin = { ...pinMediaDir('Das Modellverzeichnis', modelsDir, 0o755), destination: MEDIA_CONTAINER_MODELS_DIR }
    const verify = (mounts) => verifyMediaMounts(mounts, [pin])
    const id = await createVerified(argv, verify)
    result = await startVerifiedContainer(id, verify, { attach: true })
  }
  const { code, stdout, stderr } = result
  if (code !== 0) throw explainCheckFailure(code, stdout, stderr)
  const doc = parseInventory(stdout)

  const value = {
    source,
    container: source === 'container' ? server.name : null,
    image: config.image,
    modelsDir,
    running: running && !current ? running : null,
    checkedAt: new Date().toISOString(),
    disk: await diskUsage(modelsDir),
    models: doc.models,
  }
  cache = { key, at: Date.now(), value }
  return value
}

async function diskUsage(dir) {
  try {
    const stats = await fsp.statfs(dir)
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }
  } catch {
    return { totalBytes: null, freeBytes: null }
  }
}
