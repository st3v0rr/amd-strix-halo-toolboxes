import { z } from 'zod'

import { MEDIA_CONTAINER_MODELS_DIR, ROLE } from '../../../shared/constants.js'
import { AppError, badRequest, conflict, failedDependency, notFound } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { redact } from '../lib/redact.js'
import { buildMediaRemoveArgv } from '../podman/argv.js'
import { createVerified, imageId, startVerifiedContainer } from '../podman/client.js'
import { listServers } from '../podman/servers.js'
import { assertMediaImageAllowed, pinMediaDir, verifyMediaMounts } from './config.js'
import { mediaFetchBusy, withMediaTreeForRemoval } from './fetch.js'
import { invalidateMediaInventory, mediaInventory } from './models.js'
import { mediaStatus } from './service.js'

/** A service job that still needs its model's files. */
const OPEN_JOB = ['queued', 'running']

/** The `remove --json` document, version 1. Validated: it comes out of a container. */
export const removalSchema = z.object({
  version: z.literal(1),
  dry_run: z.boolean(),
  model: z.string(),
  profile: z.string(),
  files: z.array(z.string()),
  partials: z.array(z.string()),
  kept: z.array(z.object({ path: z.string(), used_by: z.array(z.string()) })),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  bytes: z.number().int().nonnegative(),
})

/**
 * Read what `media-api-models remove --json` printed: one document on
 * success, an `error` event on a refusal, an argparse complaint from an image
 * that predates the subcommand.
 */
export function parseRemoval(code, stdout, stderr) {
  const lines = String(stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
  let doc = null
  try {
    doc = lines.length ? JSON.parse(lines.at(-1)) : null
  } catch {
    doc = null
  }
  if (code !== 0) {
    if (/invalid choice: 'remove'/.test(String(stderr))) {
      return failedDependency(
        'Dieses Media-API-Image kann noch keine Modelle löschen. Lade oder baue das Image neu.',
      )
    }
    const detail =
      doc?.event === 'error' && typeof doc.message === 'string'
        ? doc.message
        : `${stderr}`.trim().split('\n').filter(Boolean).slice(-3).join(' · ')
    return new AppError(
      502,
      'remove_failed',
      `media-api-models remove endete mit Status ${code}${detail ? `: ${redact(detail)}` : ''}`,
    )
  }
  const result = removalSchema.safeParse(doc)
  if (!result.success) {
    return new AppError(502, 'bad_removal', 'media-api-models remove lieferte eine unbekannte Form.')
  }
  return result.data
}

/** The inventory entry for a removal request, or the reason there is none. */
async function resolveTarget(ctx, { model, profile }) {
  assertMediaImageAllowed(ctx, ctx.media.data.image)
  const inventory = await mediaInventory(ctx, { force: true })
  const entry = inventory.models.find((m) => m.id === model)
  if (!entry) {
    throw notFound(
      `Kein Modell '${model}'. Vorhanden: ${inventory.models.map((m) => m.id).join(', ') || 'keins'}.`,
    )
  }
  const chosen = entry.profiles.find((p) => p.id === profile)
  if (!chosen) {
    throw notFound(
      `${entry.label} hat kein Profil '${profile}'. Vorhanden: ${entry.profiles.map((p) => p.id).join(', ')}.`,
    )
  }
  if (chosen.status === 'unsupported') {
    throw badRequest(`${entry.label} · ${chosen.label} ist nicht nutzbar; zu löschen gibt es dafür nichts.`)
  }
  return { inventory, entry, chosen, label: `${entry.label} · ${chosen.label}` }
}

/**
 * Whether the media API service may lose these files now.
 *
 * Only a service on this same model tree matters. It mounts the tree
 * read-only and loads a profile when a job needs it, so files deleted under
 * an open job for this model would fail that job halfway; a profile that is
 * merely resident keeps working from memory until the service switches away
 * from it, and is reported, not refused. If the service cannot be asked —
 * starting, unhealthy, key rotated but not restarted, or a second media
 * container on the same tree — the removal is refused rather than guessed.
 *
 * @returns {Promise<{running: boolean, resident: boolean, container: string|null}>}
 */
async function serviceGate(ctx, modelsDir, target) {
  const { entry, chosen, label } = target
  const servers = (await listServers()).filter(
    (s) => s.role === ROLE.media && s.running && s.mediaModelsDir === modelsDir,
  )
  if (!servers.length) return { running: false, resident: false, container: null }
  const own = servers.find((s) => s.name === ctx.media.data.name)
  const foreign = servers.filter((s) => s !== own)
  if (foreign.length) {
    throw conflict(
      `Der Container ${foreign.map((s) => s.name).join(', ')} nutzt dieses Modellverzeichnis und lässt sich nicht fragen, ob er ${label} gerade braucht. Stoppe ihn zuerst.`,
    )
  }
  const status = await mediaStatus(ctx)
  const service = status.service
  if (!service || service.error) {
    const why = service?.error ?? (status.drift?.secrets ? 'der Schlüssel wurde gewechselt, der Dienst noch nicht neu angelegt' : 'nicht erreichbar')
    throw conflict(
      `Die Media API läuft auf diesem Modellverzeichnis, lässt sich aber nicht fragen, ob sie gerade ${label} benutzt (${why}). Stoppe sie auf der Server-Seite und lösche dann.`,
      { container: own.name },
    )
  }
  const open = (service.jobs ?? []).filter((j) => OPEN_JOB.includes(j.status) && j.model === entry.id)
  if (open.length) {
    throw conflict(
      `Die Media API hat ${open.length === 1 ? 'einen offenen Auftrag' : `${open.length} offene Aufträge`} mit ${entry.label}. Lösche erst, wenn ${open.length === 1 ? 'er fertig ist' : 'sie fertig sind'}, oder brich ${open.length === 1 ? 'ihn' : 'sie'} ab.`,
      { jobs: open.map((j) => j.id) },
    )
  }
  const resident = service.resident?.model === entry.id && service.resident?.profile === chosen.id
  return { running: true, resident, container: own.name }
}

async function runRemove(ctx, inventory, { model, profile, dryRun }) {
  assertMediaImageAllowed(ctx, inventory.image)
  if (!(await imageId(inventory.image))) {
    throw failedDependency(`Das Image ${inventory.image} liegt nicht lokal vor. Lade es zuerst unter „Images“.`)
  }
  const pin = {
    ...pinMediaDir('Das Modellverzeichnis', inventory.modelsDir, 0o755),
    destination: MEDIA_CONTAINER_MODELS_DIR,
  }
  const argv = buildMediaRemoveArgv({ image: inventory.image, modelsDir: pin.path, model, profile, dryRun })
  const verify = (mounts) => verifyMediaMounts(mounts, [pin])
  const id = await createVerified(argv, verify)
  const { code, stdout, stderr } = await startVerifiedContainer(id, verify, { attach: true })
  const result = parseRemoval(code, stdout, stderr)
  if (result instanceof Error) throw result
  return result
}

function residentWarning(gate, label) {
  return gate.resident
    ? `${label} ist im laufenden Dienst geladen. Er arbeitet damit aus dem Speicher weiter, bis er das Modell wechselt; danach fehlen die Dateien.`
    : null
}

/**
 * What removing a profile would delete, keep and skip — the image's own
 * `remove --dry-run`, on a read-only mount — plus whether it may run now.
 */
export async function planMediaRemoval(ctx, request) {
  const target = await resolveTarget(ctx, request)
  const plan = await runRemove(ctx, target.inventory, { ...request, dryRun: true })
  let blocked = null
  let gate = { running: false, resident: false, container: null }
  const busy = mediaFetchBusy(ctx)
  if (busy) blocked = `Es läuft ein Download für die Media API${busy.title ? ` (${busy.title})` : ''} — löschen geht erst danach.`
  try {
    gate = await serviceGate(ctx, target.inventory.modelsDir, target)
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    blocked ??= err.message
  }
  return {
    model: target.entry.id,
    profile: target.chosen.id,
    label: target.label,
    plan,
    service: { running: gate.running, resident: gate.resident, container: gate.container },
    blocked,
    warning: residentWarning(gate, target.label),
  }
}

/**
 * Delete a profile's files with the image's `media-api-models remove`.
 *
 * Refused while a fetch runs (and no fetch starts meanwhile), while the
 * service on this tree has an open job for the model or cannot be asked, and
 * when the profile has nothing of its own on disk. Which files go — and which
 * stay because another profile on disk uses them — is the image registry's
 * decision.
 */
export async function removeMediaModel(ctx, request) {
  return withMediaTreeForRemoval(ctx, async () => {
    const target = await resolveTarget(ctx, request)
    const { chosen, label } = target
    if (chosen.removable === false) {
      const shared = chosen.shared_with ?? []
      throw conflict(
        shared.length
          ? `Nichts zu löschen: alles von ${label} auf der Platte nutzt auch ${shared.join(', ')}.`
          : `Von ${label} liegt nichts auf der Platte.`,
        { sharedWith: shared },
      )
    }
    const gate = await serviceGate(ctx, target.inventory.modelsDir, target)
    try {
      const result = await runRemove(ctx, target.inventory, { ...request, dryRun: false })
      log.info(
        `Media API: ${label} gelöscht — ${result.files.length} Datei(en), ${result.partials.length} Reste, ${result.bytes} Bytes; ${result.kept.length} geteilte Datei(en) behalten.`,
      )
      return {
        model: target.entry.id,
        profile: chosen.id,
        label,
        result,
        warning: residentWarning(gate, label),
      }
    } finally {
      invalidateMediaInventory()
    }
  })
}
