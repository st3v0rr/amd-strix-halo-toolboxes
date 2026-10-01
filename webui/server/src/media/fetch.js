import { JOB_FINISHED_STATUS, MEDIA_CONTAINER_MODELS_DIR } from '../../../shared/constants.js'
import { AppError, badRequest, conflict, failedDependency, notFound } from '../lib/errors.js'
import { run } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { MEDIA_FETCH_LABEL, buildMediaFetchArgv, mediaFetchContainer } from '../podman/argv.js'
import { createVerified, imageId, removeContainer, streamVerifiedContainer } from '../podman/client.js'
import { assertMediaImageAllowed, ensureMediaDir, pinMediaDir, verifyMediaMounts } from './config.js'
import { invalidateMediaInventory, mediaInventory } from './models.js'
import { MediaFetchProgress, rateMeter } from './progress.js'

const POLL_MS = 1000
/** How long a cancelled fetch gets to stop before its container is removed by force. */
const CANCEL_GRACE_MS = 10_000
/** Its own lane, one wide (context.js): two fetches would share the CLI's staging directory. */
export const MEDIA_FETCH_LANE = 'media-fetch'

/**
 * A fetch being prepared, per job manager. Taken synchronously before the
 * first await and held until the job is registered — without it two requests
 * arriving together both pass the "nothing running" check while the first is
 * still waiting on podman.
 */
const reserved = new WeakSet()

/** The unfinished fetch job, if any. There is only ever one. */
function activeFetch(ctx) {
  return ctx.jobs
    .list({ type: 'media-model-fetch' })
    .find((j) => !JOB_FINISHED_STATUS.includes(j.status))
}

/**
 * Fetch what a profile needs by running the image's own `media-api-models
 * fetch` in a throwaway container.
 *
 * The CLI knows the pinned revisions, the target paths and the include
 * patterns — this side only decides which profile. The request is checked
 * against the inventory of the *saved* settings, and the fetch then runs with
 * exactly that inventory's image and model tree, so what was validated is what
 * gets written — also while a container still runs on older settings.
 *
 * @param {object} ctx
 * @param {{model: string, profile?: string, task?: string}} request
 */
export async function startMediaFetch(ctx, request) {
  const running = activeFetch(ctx)
  if (running || reserved.has(ctx.jobs)) {
    throw conflict(
      `Es läuft bereits ein Download für die Media API${running ? ` (${running.title})` : ''}.`,
      running ? { jobId: running.id } : undefined,
    )
  }
  reserved.add(ctx.jobs)
  try {
    return await prepareFetch(ctx, request)
  } finally {
    reserved.delete(ctx.jobs)
  }
}

async function prepareFetch(ctx, { model, profile, task }) {
  assertMediaImageAllowed(ctx, ctx.media.data.image)
  // Only the curated models are in the inventory, so only they can be fetched.
  const inventory = await mediaInventory(ctx, { force: true })
  const entry = inventory.models.find((m) => m.id === model)
  if (!entry) {
    throw notFound(
      `Kein Modell '${model}' zum Laden. Vorhanden: ${inventory.models.map((m) => m.id).join(', ') || 'keins'}.`,
    )
  }
  const chosen = entry.profiles.find((p) => p.id === (profile || entry.default_profile))
  if (!chosen) {
    throw notFound(
      `${entry.label} hat kein Profil '${profile}'. Vorhanden: ${entry.profiles.map((p) => p.id).join(', ')}.`,
    )
  }
  if (chosen.status === 'unsupported') {
    throw badRequest(`${entry.label} · ${chosen.label} ist nicht nutzbar: ${chosen.reason ?? 'nicht unterstützt'}`)
  }
  if (task && !chosen.tasks.includes(task)) {
    throw badRequest(`${entry.label} · ${chosen.label} kann '${task}' nicht. Möglich: ${chosen.tasks.join(', ')}.`)
  }
  const complete = task ? chosen.tasks_available?.[task] : chosen.available
  if (complete) {
    throw conflict(`${entry.label} · ${chosen.label} ist bereits vollständig.`)
  }
  if (chosen.downloadable === false) {
    throw failedDependency(
      `Für ${entry.label} · ${chosen.label} fehlt eine Datei ohne Download-Quelle; sie muss von Hand ins Modellverzeichnis.`,
    )
  }
  if (!(await imageId(inventory.image))) {
    throw failedDependency(`Das Image ${inventory.image} liegt nicht lokal vor. Lade es zuerst unter „Images“.`)
  }
  ensureMediaDir('Das Modellverzeichnis', inventory.modelsDir, 0o755)

  const params = {
    image: inventory.image,
    modelsDir: inventory.modelsDir,
    model: entry.id,
    profile: chosen.id,
    task: task || undefined,
  }
  // Synchronous from here: the job is registered before the reservation goes.
  return ctx.jobs.start(
    {
      type: 'media-model-fetch',
      lane: MEDIA_FETCH_LANE,
      title: `Media API: ${entry.label} · ${chosen.label}${task ? ` (${task})` : ''}`,
      meta: {
        model: entry.id,
        profile: chosen.id,
        task: task || null,
        image: inventory.image,
        modelsDir: inventory.modelsDir,
        label: `${entry.label} · ${chosen.label}`,
        estimatedMemoryGb: chosen.estimated_memory_gb,
      },
    },
    (jobCtx) => runMediaFetch(ctx, jobCtx, params),
  )
}

/** Remove fetch containers a crashed or restarted process left behind. Only ours carry the label. */
async function removeOrphans() {
  const { stdout } = await run(
    'podman',
    ['ps', '-a', '--filter', `label=${MEDIA_FETCH_LABEL}=true`, '--format', '{{.Names}}'],
    { timeoutMs: 30_000, allowFailure: true },
  )
  for (const name of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
    await run('podman', ['rm', '-f', name], { timeoutMs: 30_000, allowFailure: true })
  }
}

function runMediaFetch(ctx, { job, setProgress, appendLog, setMessage, onCancel, signal }, params) {
  const progress = new MediaFetchProgress()
  const meter = rateMeter()
  const name = mediaFetchContainer(job.id)
  let child = null
  let killTimer = null

  // Registered before anything runs, so there is no moment with a process
  // and no handler for it. The forced removal names this job's container
  // only — it can never hit a later fetch.
  onCancel(() => {
    log.info(`Media-API-Download ${params.model}/${params.profile} wird abgebrochen.`)
    child?.kill('SIGTERM')
    killTimer = setTimeout(() => {
      run('podman', ['rm', '-f', name], { timeoutMs: 30_000, allowFailure: true }).catch(() => {})
    }, CANCEL_GRACE_MS)
    killTimer.unref?.()
  })

  return new Promise((resolve, reject) => {
    let timer = null
    let settled = false

    const tick = () => {
      const snap = progress.snapshot()
      setProgress({ ...snap, ...meter(snap.done, snap.total) })
    }

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      // The token copy goes whatever happened; a cancelled fetch's container
      // still gets its forced removal if it has not exited yet.
      if (child === null || child.exitCode !== null || child.signalCode !== null) clearTimeout(killTimer)
      ctx.mediaSecrets.removeFetchToken(job.id)
      invalidateMediaInventory()
      fn()
    }

    const begin = async () => {
      await removeOrphans()
      ctx.mediaSecrets.removeFetchTokens()
      if (signal.aborted) {
        finish(() => resolve({ cancelled: true }))
        return
      }
      assertMediaImageAllowed(ctx, params.image)
      const pin = {
        ...pinMediaDir('Das Modellverzeichnis', params.modelsDir, 0o755),
        destination: MEDIA_CONTAINER_MODELS_DIR,
      }
      const modelsDir = pin.path
      const token = ctx.config.data.hfToken || ''
      const tokenFile = token ? ctx.mediaSecrets.writeFetchToken(job.id, token) : null
      const argv = buildMediaFetchArgv({
        ...params,
        modelsDir,
        name,
        tokenFile,
        disableXet: Boolean(ctx.settings.disableXet),
      })
      appendLog(
        `media-api-models fetch ${params.model} --profile ${params.profile}${params.task ? ` --task ${params.task}` : ''} → ${modelsDir}`,
      )
      setMessage('Download startet …')

      const verify = (mounts) => verifyMediaMounts(mounts, [pin])
      const id = await createVerified(argv, verify)
      if (signal.aborted) {
        await removeContainer(id, { force: true })
        finish(() => resolve({ cancelled: true }))
        return
      }
      child = await streamVerifiedContainer(id, verify, {
        onStdout: (line) => {
          const event = progress.line(line)
          if (!event) {
            if (line.trim()) appendLog(line)
            return
          }
          if (event.event === 'plan') {
            const count = progress.files.length
            appendLog(`${count} Eintrag/Einträge zu laden${progress.totalBytes !== null ? `, ${progress.totalBytes} Bytes` : ''}.`)
          } else if (event.event === 'file') {
            setMessage(`${event.index + 1}/${event.count}: ${event.path}`)
            appendLog(`→ ${event.path}`)
          } else if (event.event === 'fetched') {
            appendLog(`✓ ${event.path}`)
          } else if (event.event === 'error') {
            appendLog(`Fehler: ${event.message}`)
          }
          tick()
        },
        onStderr: (line) => {
          progress.stderr(line)
          if (line.trim()) appendLog(line)
        },
        onExit: (code, sig) => {
          if (signal.aborted) {
            appendLog('Abgebrochen. Teilweise geladene Dateien bleiben liegen; „Fortsetzen“ macht dort weiter.')
            finish(() => resolve({ cancelled: true }))
            return
          }
          if (code === 0 && progress.fetched) {
            tick()
            setMessage('Alle Dateien geladen.')
            finish(() => resolve({ model: params.model, profile: params.profile, fetched: progress.fetched }))
            return
          }
          const reason = progress.error ?? `media-api-models fetch endete mit Status ${code}${sig ? ` (${sig})` : ''}`
          finish(() => reject(new AppError(502, 'fetch_failed', `${reason}. Details stehen im Job-Log.`)))
        },
      })
      child.on('error', (err) =>
        finish(() => reject(new AppError(500, 'fetch_failed', `podman konnte nicht gestartet werden: ${err.message}`))),
      )
      // A cancel that arrived while the process was being started.
      if (signal.aborted) child.kill('SIGTERM')

      timer = setInterval(tick, POLL_MS)
      timer.unref?.()
    }

    begin().catch((err) => finish(() => reject(err)))
  })
}

/**
 * Start a finished-but-incomplete fetch again with what it was given. The
 * CLI skips what is already there and huggingface_hub resumes partials.
 */
export async function resumeMediaFetch(ctx, jobId) {
  const previous = ctx.jobs.get(jobId)
  if (previous.type !== 'media-model-fetch') throw badRequest('Dieser Job ist kein Media-API-Download.')
  if (!previous.finished) throw conflict('Dieser Download läuft noch — er muss nicht fortgesetzt werden.')
  const { model, profile, task } = previous.meta ?? {}
  if (!model) throw badRequest('Zu diesem Job sind keine Download-Angaben gespeichert.')
  const job = await startMediaFetch(ctx, { model, profile, task: task || undefined })
  ctx.jobs.cancel(previous.id)
  return job
}
