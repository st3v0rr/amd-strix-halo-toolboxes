import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { IMAGE_REPO, MEDIA_TAGS } from '../../../shared/constants.js'
import { configDir, stateDir } from '../config/paths.js'
import { mediaConfigSchema } from '../config/schema.js'
import { badRequest, conflict, failedDependency } from '../lib/errors.js'
import { buildMediaRunArgv, mediaContainerEnv } from '../podman/argv.js'
import { podmanRootless } from '../podman/client.js'

/** What PUT /media/config accepts: any setting, none of the bookkeeping. */
export const mediaConfigPatchSchema = mediaConfigSchema
  .omit({ version: true, updatedAt: true })
  .partial()

/**
 * Refuse unless the podman we talk to — local, or whatever CONTAINER_HOST
 * names — runs rootless. `--userns=keep-id` and the whole hardening story
 * assume it, and a podman that will not say is treated like one that is not.
 */
export async function assertRootlessPodman() {
  const rootless = await podmanRootless()
  if (rootless === true) return
  throw failedDependency(
    rootless === false
      ? 'Podman läuft rootful. Die Media API ist für rootless Podman gebaut (--userns=keep-id) und wird so nicht gestartet — installiere das Webinterface als normaler Benutzer, siehe toolboxes_media_api/README.md.'
      : 'Podman sagt nicht, ob es rootless läuft (podman info schlug fehl). Ohne diese Gewissheit startet die Media API nicht.',
  )
}

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
 * resolved form. Both media mounts run as the user (keep-id), and the data
 * mount is writable: `$HOME` would hand the service the web interface's JWT
 * secret, `~/.ssh` an authorized_keys, /run/user the podman socket itself.
 */
function protectedDirs() {
  const home = os.homedir()
  const both = (list) => [...new Set(list.flatMap((d) => [path.resolve(d), canonicalOrSelf(d)]))]
  return {
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
  const { containing, within } = protectedDirs()
  for (const candidate of new Set([abs, real])) {
    const exposed = containing.find((d) => inside(d, candidate))
    if (exposed) {
      throw badRequest(`${label} ${abs} enthält ${exposed} — der Container bekäme Zugriff darauf. Wähle einen eigenen Unterordner.`)
    }
    const nested = within.find((d) => inside(candidate, d))
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

/** The model tree the service reads: its own setting, or else the ComfyUI tree. */
export function mediaModelsDir(ctx, config = ctx.media.data) {
  return path.resolve(config.modelsDir || ctx.settings.comfyModelsDir)
}

/**
 * Everything the settings allow on their own but not together, plus the path
 * rules. Called on save and again right before a container is created, since
 * the ComfyUI tree the models may default to is a setting of its own.
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
