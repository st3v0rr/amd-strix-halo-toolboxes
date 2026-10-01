import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { IMAGE_REPO, MEDIA_TAGS } from '../../../shared/constants.js'
import { configDir, stateDir } from '../config/paths.js'
import { mediaConfigSchema } from '../config/schema.js'
import { badRequest, conflict, failedDependency } from '../lib/errors.js'
import { buildMediaRunArgv, mediaContainerEnv } from '../podman/argv.js'

/** What PUT /media/config accepts: any setting, none of the bookkeeping. */
export const mediaConfigPatchSchema = mediaConfigSchema
  .omit({ version: true, updatedAt: true })
  .partial()

const inside = (child, parent) =>
  child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)

function lexists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Where a path really leads: the existing part resolved by realpath, the rest
 * appended as written. Throws on a link that points nowhere.
 */
function canonical(abs) {
  let head = abs
  const tail = []
  while (!lexists(head)) {
    tail.unshift(path.basename(head))
    head = path.dirname(head)
  }
  return path.join(fs.realpathSync(head), ...tail)
}

function canonicalOrSelf(p) {
  try {
    return canonical(path.resolve(p))
  } catch {
    return path.resolve(p)
  }
}

/**
 * A link we follow: made by root in a directory only root can write — the
 * system's own layout, such as /home → /var/home on Fedora Atomic and Bazzite.
 * Anyone else's link is a way to point a mount somewhere no check looked.
 */
export function trustedLink(link, parent) {
  return link.uid === 0 && parent.uid === 0 && (parent.mode & 0o022) === 0
}

/**
 * Nobody but this user and root may be able to rename anything on the path:
 * every directory is owned by one of them and has no group/world write bit.
 * This deliberately rejects sticky and same-primary-group exceptions. They
 * are subtle, and a supplementary-group peer is part of the threat model.
 * Once this invariant is rechecked immediately before `podman start`, only
 * root or this same UID can swap a component; root is trusted and same-UID
 * attackers are explicitly outside this service's isolation boundary.
 */
function safeDir(st) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid
  return (st.uid === uid || st.uid === 0) && (st.mode & 0o022) === 0
}

function assertNoForeignLinks(label, abs) {
  let current = path.parse(abs).root
  for (const part of abs.split(path.sep).filter(Boolean)) {
    const next = path.join(current, part)
    let stat
    try {
      stat = fs.lstatSync(next)
    } catch {
      return // the rest does not exist yet
    }
    if (stat.isSymbolicLink() && !trustedLink(stat, fs.statSync(current))) {
      throw badRequest(`${label}: ${next} ist ein symbolischer Link. Trag den Pfad ein, auf den er zeigt.`)
    }
    const dir = stat.isSymbolicLink() ? fs.statSync(next) : stat
    if (dir.isDirectory() && !safeDir(dir)) {
      throw badRequest(
        `${label}: in ${next} dürfen andere schreiben — sie könnten den Pfad zwischen Prüfung und Mount austauschen.`,
      )
    }
    current = next
  }
}

/**
 * Directories no container of ours may mount, each in its written and its
 * resolved form. The data mount is writable — by container root, which on this
 * rootful appliance is root on the host: `$HOME` would hand it the WebUI's JWT
 * secret, `~/.ssh` an authorized_keys, /run/podman the podman socket itself.
 *
 * /root is always off limits, except for the two exact default trees of the
 * root-only appliance — and only there, where the service's own home is /root.
 * Any other service keeps root's home off limits altogether, and even on the
 * appliance no other subtree of /root becomes mountable.
 */
function protectedDirs() {
  const home = os.homedir()
  const both = (list) => [...new Set(list.flatMap((d) => [path.resolve(d), canonicalOrSelf(d)]))]
  return {
    home,
    containing: both([home, configDir, stateDir]),
    within: both([
      configDir,
      stateDir,
      path.join(home, '.ssh'),
      path.join(home, '.gnupg'),
      path.join(home, '.config'),
      path.join(home, '.local', 'share', 'containers'),
      '/etc',
      '/usr',
      '/boot',
      '/proc',
      '/sys',
      '/dev',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/root',
      '/run/user',
      '/run/podman',
      '/run/containers',
      '/var/lib/containers',
    ]),
  }
}

const ROOT_MEDIA_TREES = ['/root/media-api-models', '/root/media-api-data']

/**
 * Only the appliance defaults (and their descendants) may live under /root,
 * and only for a service whose home is /root itself.
 */
function allowedRootMediaTree(candidate, home) {
  if (canonicalOrSelf(home) !== canonicalOrSelf('/root')) return false
  return ROOT_MEDIA_TREES.map(canonicalOrSelf).some((root) => inside(candidate, root))
}

/**
 * Refuse a directory the container must not get.
 *
 * Checked on the resolved path as well as the written one, and no link but
 * root's system links is followed on the way — otherwise `/tmp/x → ~/.ssh`
 * would pass as `/tmp/x`.
 *
 * @returns {string} the canonical path, which is what gets mounted
 */
export function checkMediaDir(label, dir) {
  if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) {
    throw badRequest(`${label} muss ein absoluter Pfad sein.`)
  }
  // podman reads `-v src:dst:opts`; a colon or comma in the source would be
  // taken as the next field.
  if (/[:,\0\n\r]/.test(dir)) {
    throw badRequest(`${label} darf weder ':' noch ',' enthalten — podman läse den Rest als Mount-Option.`)
  }
  const abs = path.resolve(dir)
  assertNoForeignLinks(label, abs)
  let real
  try {
    real = canonical(abs)
  } catch {
    throw badRequest(`${label} ${abs} führt über einen Link ins Leere.`)
  }
  const { home, containing, within } = protectedDirs()
  for (const candidate of new Set([abs, real])) {
    const exposed = containing.find((d) => inside(d, candidate))
    if (exposed) {
      throw badRequest(`${label} ${abs} enthält ${exposed} — der Container bekäme Zugriff darauf. Wähle einen eigenen Unterordner.`)
    }
    const nested = within.find((d) => {
      if (canonicalOrSelf(d) === canonicalOrSelf('/root') && allowedRootMediaTree(candidate, home)) return false
      return inside(candidate, d)
    })
    if (nested) throw badRequest(`${label} ${abs} liegt in ${nested}; das darf kein Container mounten.`)
  }
  return real
}

/**
 * Create a mount source if needed and return the path to mount — checked
 * again after the mkdir, since the moment right before podman runs is the one
 * that counts. Only a real directory of this user (or root) passes.
 */
export function ensureMediaDir(label, dir, mode) {
  const real = checkMediaDir(label, dir)
  try {
    fs.mkdirSync(real, { recursive: true, mode })
  } catch (err) {
    throw failedDependency(`Verzeichnis ${real} lässt sich nicht anlegen: ${err.message}`)
  }
  const again = checkMediaDir(label, real)
  const stat = fs.lstatSync(again)
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (again !== real || !stat.isDirectory() || (uid !== null && stat.uid !== uid && stat.uid !== 0)) {
    throw conflict(`${label} ${real} hat sich beim Prüfen verändert oder gehört nicht diesem Benutzer.`)
  }
  return real
}

/**
 * ensureMediaDir plus the identity of what was checked, for verifyMediaMounts.
 * @returns {{label: string, path: string, dev: number, ino: number}}
 */
export function pinMediaDir(label, dir, mode) {
  const real = ensureMediaDir(label, dir, mode)
  const { dev, ino } = fs.lstatSync(real)
  return { label, path: real, dev, ino }
}

/**
 * Between `podman create` and `start`: every bind source must be exactly the
 * pinned directory — same canonical path, same device and inode, still passing
 * every rule. A source replaced after the check fails here, before the
 * container ever runs.
 *
 * @param {{Source: string, Destination: string}[]} mounts from `podman inspect`
 * @param {{label: string, path: string, dev: number, ino: number, destination: string}[]} pins
 */
export function verifyMediaMounts(mounts, pins) {
  for (const pin of pins) {
    const mount = mounts.find((m) => m.Destination === pin.destination)
    if (!mount || mount.Source !== pin.path) {
      throw conflict(`${pin.label}: podman würde ${mount?.Source ?? 'nichts'} statt ${pin.path} mounten — abgebrochen.`)
    }
    const again = checkMediaDir(pin.label, pin.path)
    const st = fs.lstatSync(again)
    if (again !== pin.path || !st.isDirectory() || st.dev !== pin.dev || st.ino !== pin.ino) {
      throw conflict(`${pin.label} ${pin.path} wurde zwischen Prüfung und Start ersetzt — abgebrochen.`)
    }
  }
}

/**
 * With custom images off, only the media image of this repository may run as
 * the service or its throwaway containers — anything else would get the model
 * tree, the network or a token.
 */
export function assertMediaImageAllowed(ctx, image) {
  if (ctx.settings.allowCustomImages) return
  const allowed = MEDIA_TAGS.map((tag) => `${IMAGE_REPO}:${tag}`)
  if (!allowed.includes(image)) {
    throw badRequest(
      `Nur das Media-API-Image (${allowed.join(', ')}) ist erlaubt. Beliebige Images lassen sich in den Einstellungen freischalten.`,
    )
  }
}

/** The model tree the service reads: its own setting, or else the general media tree. */
export function mediaModelsDir(ctx, config = ctx.media.data) {
  return path.resolve(config.modelsDir || ctx.settings.mediaModelsDir)
}

/**
 * Everything the settings allow on their own but not together, plus the path
 * rules. Called on save and again right before a container is created, since
 * the tree the models may default to is a general setting of its own.
 */
export function checkMediaConfig(ctx, config) {
  const modelsDir = checkMediaDir('Das Modellverzeichnis', mediaModelsDir(ctx, config))
  const dataDir = checkMediaDir('Das Datenverzeichnis', config.dataDir)
  if (inside(modelsDir, dataDir) || inside(dataDir, modelsDir)) {
    throw badRequest('Modell- und Datenverzeichnis dürfen nicht ineinander liegen.')
  }
  if (config.allowDownloads && config.modelsReadOnly) {
    throw badRequest(
      'Lädt der Dienst selbst herunter, braucht er einen beschreibbaren Modell-Mount. Entweder ' +
        '„schreibgeschützt“ abschalten oder Downloads dem Dienst verbieten und über „Laden“ holen.',
    )
  }
  return { modelsDir, dataDir }
}

/**
 * The stored settings with `patch` applied, checked as a whole and with its
 * paths in the canonical form they are mounted in — but not stored yet.
 * Shared by PUT /media/config and the Servers page's start, which stores only
 * once the container runs.
 *
 * @param {object} ctx
 * @param {object} patch any subset of the settings
 * @returns {object} a complete mediaConfigSchema object
 */
export function resolveMediaConfig(ctx, patch) {
  const merged = mediaConfigSchema.safeParse({ ...ctx.media.data, ...patch })
  if (!merged.success) {
    const issue = merged.error.issues[0]
    throw badRequest(`Ungültige Eingabe bei ${issue.path.join('.')}: ${issue.message}`)
  }
  const config = { ...merged.data, updatedAt: new Date().toISOString() }
  assertMediaImageAllowed(ctx, config.image)
  const { modelsDir, dataDir } = checkMediaConfig(ctx, config)
  // Stored normalized, so the drift check compares like with like.
  config.dataDir = dataDir
  if (config.modelsDir) config.modelsDir = modelsDir
  return config
}

/** Store settings from resolveMediaConfig, durably, before anyone is told. */
export async function saveMediaConfig(ctx, config) {
  const previous = structuredClone(ctx.media.data)
  try {
    await ctx.media.update(() => config)
    await ctx.media.flush()
    return ctx.media.data
  } catch (err) {
    try {
      await ctx.media.update(() => previous)
      await ctx.media.flush()
    } catch (rollbackErr) {
      throw failedDependency(
        `Die Media-API-Einstellungen konnten nicht gespeichert und der alte Stand nicht wiederhergestellt werden: ${rollbackErr.message}`,
      )
    }
    throw err
  }
}

/**
 * The container spec the current settings produce, with the hash that goes
 * into its labels.
 *
 * The hash covers the complete run argv minus labels: two specs with the same
 * hash start identical containers, so a running container whose label differs
 * from this is running on outdated settings. Paths are canonical, as mounted.
 */
export function mediaSpec(ctx, config = ctx.media.data) {
  const files = ctx.mediaSecrets.paths()
  const hfToken = config.allowDownloads && ctx.config.data.hfToken ? files.hfToken : null
  const spec = {
    containerName: config.name,
    image: config.image,
    hostPort: config.port,
    bindAddress: config.bindAddress,
    modelsDir: canonicalOrSelf(mediaModelsDir(ctx, config)),
    modelsReadOnly: config.modelsReadOnly,
    dataDir: canonicalOrSelf(config.dataDir),
    backend: config.backend,
    allowDownloads: config.allowDownloads,
    secretFiles: {
      apiKey: files.apiKey,
      sessionSecret: files.sessionSecret,
      hfToken: hfToken ? files.hfTokenDir : null,
    },
    env: mediaContainerEnv(config, { hfToken: Boolean(hfToken) }),
  }
  const argv = buildMediaRunArgv({ ...spec, labels: {} })
  spec.specHash = createHash('sha256').update(JSON.stringify(argv)).digest('hex').slice(0, 16)
  return spec
}
