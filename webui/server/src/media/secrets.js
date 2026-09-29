import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { checkMediaApiKey, checkMediaSessionSecret } from '../../../shared/media.js'
import { badRequest, failedDependency } from '../lib/errors.js'
import { registerSecret, unregisterSecret } from '../lib/redact.js'

const FILES = {
  apiKey: 'api-key',
  sessionSecret: 'session-secret',
  hfToken: 'hf-token/token',
  pepper: 'fingerprint-pepper',
}
const FETCH_TOKEN_RE = /^fetch-[A-Za-z0-9]{1,64}\.token$/

/** 32 random bytes: 43 characters, far past the service's 16 and 32 minimums. */
function generate() {
  return randomBytes(32).toString('base64url')
}

/**
 * The media API's key and session secret, as 0600 files in a 0700 directory.
 *
 * Files rather than values because that is how they reach the container: each
 * is mounted read-only and named by MEDIA_API_KEY_FILE / MEDIA_SESSION_SECRET_FILE,
 * so neither ever appears in an argv, a label, `podman inspect` or a process
 * listing. The web interface generates both, can replace them, and reads the
 * key itself only to ask the running service for its status — no route ever
 * hands a value back out. Every value read here is registered with the
 * redactor, so one that slips into a log line comes out as `***`.
 *
 * @param {string} dir absolute directory, created on first use
 */
export function createMediaSecrets(dir, io = fs) {
  // A known kind, or (for the fetch copies) a file name made safe by the caller.
  const file = (kind) => path.join(dir, FILES[kind] ?? path.basename(kind))

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // mkdir's mode is masked by umask, and an existing directory keeps its own.
    fs.chmodSync(dir, 0o700)
  }

  function read(kind) {
    try {
      const value = fs.readFileSync(file(kind), 'utf8').trim()
      registerSecret(value)
      return value || null
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw failedDependency(`${file(kind)} ist nicht lesbar: ${err.code ?? err.message}`)
    }
  }

  /** Atomic replace: a half-written key would lock the service out on its next start. */
  function write(kind, value) {
    ensureDir()
    const target = file(kind)
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, `${value}\n`, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, target)
    fs.chmodSync(target, 0o600)
    registerSecret(value)
  }

  /**
   * Failure-atomic token replacement. The container bind-mounts the enclosing
   * 0700 directory, so an atomic rename is visible there without ever exposing
   * a truncated/partial token. The directory fsync makes the rename durable.
   */
  function writeToken(value) {
    ensureDir()
    const target = file('hfToken')
    const parent = path.dirname(target)
    io.mkdirSync(parent, { recursive: true, mode: 0o700 })
    io.chmodSync(parent, 0o700)
    const tmp = path.join(parent, `.token.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
    let fd
    try {
      fd = io.openSync(tmp, 'wx', 0o600)
      io.writeFileSync(fd, value ? `${value}\n` : '', 'utf8')
      // Creation mode is subject to umask; publish only an inode whose exact
      // mode and contents have both been flushed.
      io.fchmodSync(fd, 0o600)
      io.fsyncSync(fd)
      io.closeSync(fd)
      fd = undefined
      io.renameSync(tmp, target)
      const dirFd = io.openSync(parent, fs.constants.O_RDONLY)
      try {
        io.fsyncSync(dirFd)
      } finally {
        io.closeSync(dirFd)
      }
    } catch (err) {
      if (fd !== undefined) {
        try {
          io.closeSync(fd)
        } catch {
          /* preserve the operation error */
        }
      }
      try {
        io.rmSync(tmp, { force: true })
      } catch {
        /* best effort: an unreferenced 0600 temp contains no partial live state */
      }
      throw err
    }
  }

  /**
   * An HMAC under a random local key rather than a plain hash: a plain hash of
   * a weak, user-chosen key is a verifier anyone who sees the page could
   * brute-force offline. This tells "changed" from "unchanged" and nothing more.
   */
  function fingerprint(value) {
    let pepper = read('pepper')
    if (!pepper) {
      pepper = generate()
      write('pepper', pepper)
    }
    return createHmac('sha256', pepper).update(value, 'utf8').digest('hex').slice(0, 12)
  }

  function describe(kind) {
    const value = read(kind)
    if (!value) return { configured: false, fingerprint: null, updatedAt: null }
    const stat = fs.statSync(file(kind))
    return { configured: true, fingerprint: fingerprint(value), updatedAt: stat.mtime.toISOString() }
  }

  const fetchTokenFile = (jobId) => path.join(dir, `fetch-${String(jobId).replace(/[^A-Za-z0-9]/g, '').slice(0, 64)}.token`)

  return {
    dir,
    paths: () => ({
      apiKey: file('apiKey'),
      sessionSecret: file('sessionSecret'),
      hfToken: file('hfToken'),
      hfTokenDir: path.dirname(file('hfToken')),
    }),

    /** For the status page and the MCP tools. No values. */
    status() {
      return { dir, apiKey: describe('apiKey'), sessionSecret: describe('sessionSecret') }
    },

    /**
     * Make sure both secrets exist and would be accepted by the service.
     *
     * A missing one is generated. An existing one that the service would refuse
     * is reported rather than silently replaced — it may be a key clients
     * already use, and overwriting it would lock them out.
     */
    ensure() {
      let key = read('apiKey')
      if (!key) {
        key = generate()
        write('apiKey', key)
      }
      const keyProblem = checkMediaApiKey(key)
      if (keyProblem) {
        throw failedDependency(`Der gespeicherte API-Schlüssel (${file('apiKey')}) taugt nicht: ${keyProblem}`)
      }
      let secret = read('sessionSecret')
      if (!secret) {
        secret = generate()
        write('sessionSecret', secret)
      }
      const secretProblem = checkMediaSessionSecret(secret, key)
      if (secretProblem) {
        throw failedDependency(
          `Das gespeicherte Sitzungsgeheimnis (${file('sessionSecret')}) taugt nicht: ${secretProblem}`,
        )
      }
      // A file someone copied in by hand may be group-readable; the service
      // mounts it, but nobody else on the box needs to read it.
      for (const kind of ['apiKey', 'sessionSecret']) fs.chmodSync(file(kind), 0o600)
      return this.status()
    },

    /** The key, for the server's own calls to the service. Never for a response. */
    apiKey() {
      return read('apiKey')
    },

    /** Replace a secret with a fresh random one. */
    rotate(kind) {
      if (!['apiKey', 'sessionSecret'].includes(kind)) throw badRequest(`Unbekanntes Geheimnis '${kind}'.`)
      const previous = read(kind)
      let next = generate()
      // Astronomically unlikely, but the service refuses a session secret equal to the key.
      while (next === (kind === 'apiKey' ? read('sessionSecret') : read('apiKey'))) next = generate()
      write(kind, next)
      if (previous) unregisterSecret(previous)
      return this.status()
    },

    /** Set a key the user chose, e.g. one their clients already carry. */
    setApiKey(value) {
      const problem = checkMediaApiKey(value)
      if (problem) throw badRequest(`Dieser Schlüssel wäre für die Media API ungültig: ${problem}`)
      if (value === read('sessionSecret')) {
        throw badRequest('Der Schlüssel muss sich vom Sitzungsgeheimnis unterscheiden.')
      }
      const previous = read('apiKey')
      write('apiKey', value)
      if (previous && previous !== value) unregisterSecret(previous)
      return this.status()
    },

    /**
     * Keep the Hugging Face token file in step with what the service may use.
     * Only a service allowed to download gets one; otherwise the file is gone.
     *
     * @param {string|null} token
     * @returns {string|null} the file to mount, or null
     */
    syncHfToken(token) {
      const target = file('hfToken')
      if (token) {
        writeToken(token)
        return target
      }
      // Keep an empty file when mounted. Atomic replacement revokes it without
      // the O_TRUNC failure mode and is immediately visible through the bound directory.
      // Apply then removes it because the replacement container will not mount it.
      if (fs.existsSync(target)) {
        writeToken('')
        fs.rmSync(target, { force: true })
      }
      return null
    },

    /**
     * The global token changed or went away: a service that got a token file
     * sees that at once — same file, new content (or none). One that got no
     * file keeps having none; the next apply decides that.
     *
     * @returns {boolean} whether a mounted file was touched
     */
    refreshHfToken(token) {
      const target = file('hfToken')
      if (!fs.existsSync(target)) return false
      writeToken(token || '')
      return true
    },

    /** 'none': no file; 'active': a token is mounted; 'revoked': emptied, awaiting re-creation. */
    hfTokenState() {
      try {
        return fs.readFileSync(file('hfToken'), 'utf8').trim() ? 'active' : 'revoked'
      } catch {
        return 'none'
      }
    },

    /** A fetch's own read-only copy of the token, gone when the job ends. */
    writeFetchToken(jobId, token) {
      const target = fetchTokenFile(jobId)
      write(path.basename(target), token)
      return target
    },

    removeFetchToken(jobId) {
      fs.rmSync(fetchTokenFile(jobId), { force: true })
    },

    /** Copies a crashed process left behind. */
    removeFetchTokens() {
      let entries = []
      try {
        entries = fs.readdirSync(dir)
      } catch {
        return
      }
      for (const name of entries) {
        if (FETCH_TOKEN_RE.test(name)) fs.rmSync(path.join(dir, name), { force: true })
      }
    },

    /** When a secret last changed, to tell whether the container still has the old one. */
    changedAt(kind) {
      try {
        return fs.statSync(file(kind)).mtime
      } catch {
        return null
      }
    },

    /**
     * Opaque rollback point for container creation. A failed start must not
     * create or rotate either mounted credential. Secret values stay inside
     * this closure and are never returned to a route, log or subprocess.
     */
    checkpoint() {
      const previous = Object.fromEntries(['apiKey', 'sessionSecret'].map((kind) => [kind, read(kind)]))
      let finished = false
      return {
        commit() {
          finished = true
        },
        rollback() {
          if (finished) return
          for (const kind of ['apiKey', 'sessionSecret']) {
            const current = read(kind)
            if (previous[kind] === null) {
              fs.rmSync(file(kind), { force: true })
              if (current) unregisterSecret(current)
            } else if (current !== previous[kind]) {
              write(kind, previous[kind])
              if (current) unregisterSecret(current)
            }
          }
          finished = true
        },
      }
    },
  }
}
