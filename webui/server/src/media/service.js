import { ROLE } from '../../../shared/constants.js'
import { mediaConfigWarnings } from '../../../shared/media.js'
import { imageId, inspectContainer, podmanRootless } from '../podman/client.js'
import { listServers, probeHost, serverHealth } from '../podman/servers.js'
import { mediaSpec } from './config.js'

/** For the page only; apply and fetch ask podman afresh every time. */
const ROOTLESS_CACHE_MS = 60_000
let rootlessCache = { at: 0, value: null }

async function cachedRootless() {
  if (Date.now() - rootlessCache.at < ROOTLESS_CACHE_MS) return rootlessCache.value
  rootlessCache = { at: Date.now(), value: await podmanRootless() }
  return rootlessCache.value
}

const SERVICE_TIMEOUT_MS = 4000
/** The service throttles failed keys per client; a short cache keeps polling from adding up. */
const SERVICE_CACHE_MS = 3000

let serviceCache = { key: null, at: 0, value: null }

/**
 * A GET against the running service, authenticated with the stored key.
 *
 * The address comes from the container's own labels, the path from this
 * file — nothing a request carries — so this cannot be pointed anywhere else.
 * The key goes into the header and nowhere further; the redactor knows it.
 */
async function serviceGet(server, apiKey, path) {
  const res = await fetch(`http://${probeHost(server.bindAddress)}:${server.hostPort}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.status, ok: res.ok, body }
}

function explainServiceStatus(status) {
  if (status === 401) {
    return 'Der Dienst lehnt den gespeicherten Schlüssel ab. Nach einem Schlüsselwechsel muss er neu starten.'
  }
  if (status === 429) return 'Der Dienst drosselt nach zu vielen Fehlversuchen; in ein paar Minuten erneut.'
  return `Der Dienst antwortete mit ${status}.`
}

/**
 * What the running service says about itself: backend, the resident model,
 * its limits and the recent jobs. Read-only.
 */
export async function mediaServiceInfo(ctx, server) {
  const key = `${server.name}:${server.id}`
  if (serviceCache.key === key && Date.now() - serviceCache.at < SERVICE_CACHE_MS) return serviceCache.value

  const apiKey = ctx.mediaSecrets.apiKey()
  let value
  if (!apiKey) {
    value = { error: 'Kein API-Schlüssel gespeichert.' }
  } else {
    try {
      const [models, jobs] = await Promise.all([
        serviceGet(server, apiKey, '/api/v1/models'),
        serviceGet(server, apiKey, '/api/v1/jobs?limit=20'),
      ])
      if (!models.ok) {
        value = { error: explainServiceStatus(models.status), status: models.status }
      } else {
        value = {
          backend: models.body?.backend ?? null,
          resident: models.body?.resident ?? null,
          limits: models.body?.limits ?? null,
          jobs: jobs.ok ? (jobs.body?.data ?? []).map(publicJob) : [],
        }
      }
    } catch (err) {
      value = { error: err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message }
    }
  }
  serviceCache = { key, at: Date.now(), value }
  return value
}

/** A service job for the management page: state, not the generated content. */
function publicJob(job) {
  const prompt = typeof job?.params?.prompt === 'string' ? job.params.prompt : ''
  return {
    id: job.id,
    task: job.task,
    model: job.model,
    profile: job.profile,
    status: job.status,
    stage: job.stage ?? null,
    progress: typeof job.progress === 'number' ? job.progress : null,
    queuePosition: job.queue_position ?? null,
    createdAt: job.created_at ?? null,
    finishedAt: job.finished_at ?? null,
    error: job.error ?? null,
    prompt: prompt.length > 160 ? `${prompt.slice(0, 159)}…` : prompt,
  }
}

/**
 * Everything the media page and the MCP tool show in one answer: settings,
 * secrets (fingerprints only), the container, whether it is healthy, whether
 * it still runs on the current settings and secrets, and the service's view.
 */
export async function mediaStatus(ctx) {
  const config = ctx.media.data
  const spec = mediaSpec(ctx, config)
  const servers = await listServers()
  const mediaServers = servers.filter((s) => s.role === ROLE.media)
  const summary = mediaServers.find((s) => s.name === config.name) ?? null

  let container = null
  if (summary) {
    const inspect = await inspectContainer(summary.name)
    container = {
      ...summary,
      startedAt: inspect?.State?.StartedAt ?? null,
      exitCode: inspect?.State?.ExitCode ?? null,
      restarts: inspect?.RestartCount ?? null,
    }
  }

  const secrets = ctx.mediaSecrets.status()
  const startedAt = container?.startedAt ? new Date(container.startedAt) : null
  const secretsChanged = Boolean(
    container?.running &&
      startedAt &&
      !Number.isNaN(startedAt.getTime()) &&
      ['apiKey', 'sessionSecret'].some((kind) => (ctx.mediaSecrets.changedAt(kind) ?? 0) > startedAt),
  )
  const drift = {
    config: Boolean(container && container.specHash !== spec.specHash),
    secrets: secretsChanged,
  }

  let health = null
  let service = null
  if (container?.running) {
    health = await serverHealth(container.name).catch((err) => ({ reachable: false, reason: err.message }))
    // With a rotated key the service still holds the old one; asking with the
    // new one would only feed its failed-login throttle — which the playground
    // users on this host share.
    if (health.reachable && !drift.secrets) service = await mediaServiceInfo(ctx, container)
  }

  return {
    config,
    effective: { modelsDir: spec.modelsDir, dataDir: spec.dataDir },
    secrets: {
      ...secrets,
      apiKeyFile: ctx.mediaSecrets.paths().apiKey,
      // Whether the running service holds a Hugging Face token file: 'active',
      // 'revoked' (emptied when the token was removed; gone with the next
      // apply) or 'none'.
      hfToken: ctx.mediaSecrets.hfTokenState(),
    },
    image: { ref: config.image, installed: Boolean(await imageId(config.image)) },
    container,
    others: mediaServers.filter((s) => s.name !== config.name).map((s) => s.name),
    health,
    service,
    drift,
    rootless: await cachedRootless(),
    warnings: mediaConfigWarnings(config),
  }
}
