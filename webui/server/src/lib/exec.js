import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppError } from './errors.js'
import { log } from './log.js'
import { redact } from './redact.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(here, '../../..')

/**
 * Every external binary this app runs goes through here.
 *
 * Two reasons. First, security: `execFile`/`spawn` with an argv array means a
 * model path or an API key can never be reinterpreted by a shell — `shell:true`
 * is banned in this file and enforced by ESLint everywhere else. Second,
 * testability: because the binary is looked up through this table, the whole
 * app runs on a Mac without podman by pointing `SHX_PODMAN_BIN` at a fixture
 * script. That indirection is what makes the mock mode a config swap rather
 * than a code branch.
 */
const BINARIES = {
  podman: ['SHX_PODMAN_BIN', 'podman'],
  hf: ['SHX_HF_BIN', 'hf'],
  git: ['SHX_GIT_BIN', 'git'],
  python3: ['SHX_PYTHON_BIN', 'python3'],
  systemctl: ['SHX_SYSTEMCTL_BIN', 'systemctl'],
  'systemd-run': ['SHX_SYSTEMD_RUN_BIN', 'systemd-run'],
  'firewall-cmd': ['SHX_FIREWALL_CMD_BIN', 'firewall-cmd'],
}

/**
 * The override is read on every call rather than captured at import, so a test
 * can point one binary at a fixture without having to control module load
 * order.
 */
function configuredBinary(key) {
  const entry = BINARIES[key]
  if (!entry) return null
  const [envVar, fallback] = entry
  return process.env[envVar] || fallback
}

/**
 * Directories to search beyond the inherited PATH.
 *
 * systemd hands a service a minimal PATH that does not include `~/.local/bin`
 * — which is exactly where `pipx install "huggingface_hub[cli]"` puts `hf`.
 * Without this the app reports the CLI as missing while the user's shell finds
 * it perfectly well.
 */
function extraPathDirs() {
  const home = process.env.HOME || ''
  return [
    home ? path.join(home, '.local', 'bin') : null,
    home ? path.join(home, 'bin') : null,
    '/usr/local/bin',
    '/usr/local/sbin',
    '/opt/homebrew/bin',
    '/var/lib/flatpak/exports/bin',
  ].filter(Boolean)
}

/** The inherited PATH plus the extra directories, deduplicated, order kept. */
function searchDirs() {
  const fromEnv = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)
  const seen = new Set()
  const out = []
  for (const dir of [...fromEnv, ...extraPathDirs()]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out
}

/** Positive lookups only — caching a miss would hide a later installation. */
const resolvedBinaries = new Map()

export function binaryPath(key) {
  const bin = configuredBinary(key)
  if (!bin) throw new Error(`Unknown binary key: ${key}`)

  // An explicit override wins. A relative one resolves against webui/, so
  // dev/bin/podman works regardless of the working directory.
  if (bin.includes('/')) {
    return path.isAbsolute(bin) ? bin : path.join(webuiRoot, bin)
  }

  const cached = resolvedBinaries.get(key)
  if (cached) return cached

  for (const dir of searchDirs()) {
    const candidate = path.join(dir, bin)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      resolvedBinaries.set(key, candidate)
      return candidate
    } catch {
      // not here, keep looking
    }
  }

  // Not found anywhere; hand back the bare name so spawn produces a plain
  // ENOENT rather than us inventing an error here.
  return bin
}

/** Drop the resolution cache, e.g. after the user installs a missing tool. */
export function forgetBinaryPaths() {
  resolvedBinaries.clear()
}

/** Read on every call for the same reason the binary overrides are. */
export const isMock = () => process.env.SHX_MOCK === '1'

/**
 * Environment handed to subprocesses. An allowlist rather than `process.env`,
 * so nothing we hold (secrets, config paths) leaks into a container runtime or
 * a Python script that did not ask for it.
 */
function baseEnv(extra = {}) {
  const env = {
    // The augmented PATH, so a tool we launch can find its own helpers too —
    // `hf` shelling out to python being the obvious case.
    PATH: searchDirs().join(path.delimiter),
    HOME: process.env.HOME || '',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  }
  for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'CONTAINER_HOST', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  // Mock shims need to find their own fixtures.
  if (isMock()) {
    env.SHX_MOCK = '1'
    for (const key of [
      'SHX_MOCK_STATE',
      'SHX_MOCK_FIXTURES',
      'SHX_MOCK_HELP_VARIANT',
      'SHX_MOCK_XET',
      'SHX_MOCK_FIREWALL',
      'SHX_MOCK_FIREWALL_STATE',
    ]) {
      if (process.env[key]) env[key] = process.env[key]
    }
  }
  return { ...env, ...extra }
}

export class ProcessError extends AppError {
  constructor(binKey, argv, code, stdout, stderr) {
    const detail = (stderr || stdout || '').trim().split('\n').slice(-4).join('\n')
    super(
      500,
      'process_failed',
      `${binKey} ${argv[0] ?? ''} schlug fehl (exit ${code})${detail ? `: ${redact(detail)}` : ''}`,
    )
    this.name = 'ProcessError'
    this.binKey = binKey
    this.argv = argv
    this.exitCode = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

/**
 * Run a command to completion and capture its output.
 *
 * @param {keyof typeof BINARIES} binKey
 * @param {string[]} argv
 * @param {{timeoutMs?: number, env?: Record<string,string>, maxBuffer?: number,
 *          allowFailure?: boolean, cwd?: string}} [opts]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export function run(binKey, argv, opts = {}) {
  const {
    timeoutMs = 30_000,
    env = {},
    maxBuffer = 16 * 1024 * 1024,
    allowFailure = false,
    cwd,
  } = opts
  const bin = binaryPath(binKey)

  return new Promise((resolve, reject) => {
    log.debug(`exec ${binKey} ${redact(argv.join(' '))}`)
    execFile(
      bin,
      argv,
      { timeout: timeoutMs, env: baseEnv(env), maxBuffer, cwd, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err?.code ?? 0
        if (err && err.code === 'ENOENT') {
          reject(
            new AppError(
              424,
              'binary_missing',
              `'${bin}' wurde nicht gefunden. Ist es installiert und im PATH?`,
            ),
          )
          return
        }
        if (err && err.killed) {
          reject(
            new AppError(
              504,
              'process_timeout',
              `${binKey} ${argv[0] ?? ''} hat nach ${timeoutMs} ms nicht geantwortet.`,
            ),
          )
          return
        }
        if (err && !allowFailure) {
          reject(new ProcessError(binKey, argv, code, stdout, stderr))
          return
        }
        resolve({ code: typeof code === 'number' ? code : 0, stdout, stderr })
      },
    )
  })
}

/**
 * Run a command and receive its output line by line as it arrives.
 *
 * Splits on both `\n` and `\r` because podman and tqdm both redraw progress
 * with carriage returns — treating `\r` as a line terminator is what turns
 * that into a readable stream of updates.
 *
 * @param {keyof typeof BINARIES} binKey
 * @param {string[]} argv
 * @param {{env?: Record<string,string>, cwd?: string, detached?: boolean,
 *          onStdout?: (line: string) => void, onStderr?: (line: string) => void,
 *          onExit?: (code: number|null, signal: string|null) => void}} [opts]
 */
export function stream(binKey, argv, opts = {}) {
  const { env = {}, cwd, detached = false, onStdout, onStderr, onExit } = opts
  const bin = binaryPath(binKey)
  log.debug(`stream ${binKey} ${redact(argv.join(' '))}`)

  const child = spawn(bin, argv, {
    env: baseEnv(env),
    cwd,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (onStdout) attachLineReader(child.stdout, onStdout)
  if (onStderr) attachLineReader(child.stderr, onStderr)
  if (onExit) child.on('close', (code, signal) => onExit(code, signal))

  return child
}

/** Feed complete lines to `onLine`, buffering partial ones across chunks. */
export function attachLineReader(readable, onLine) {
  let buffer = ''
  readable.setEncoding('utf8')
  readable.on('data', (chunk) => {
    buffer += chunk
    // Both terminators, so carriage-return progress redraws surface promptly.
    const parts = buffer.split(/\r\n|\r|\n/)
    buffer = parts.pop() ?? ''
    for (const line of parts) onLine(line)
  })
  readable.on('end', () => {
    if (buffer) {
      onLine(buffer)
      buffer = ''
    }
  })
}

/** Whether a binary is callable at all. Used for preflight banners in the UI. */
export async function which(binKey, versionArgs = ['--version']) {
  try {
    const { stdout, stderr } = await run(binKey, versionArgs, {
      timeoutMs: 5000,
      allowFailure: true,
    })
    const out = (stdout || stderr).trim().split('\n')[0] || ''
    return { available: true, version: out }
  } catch {
    return { available: false, version: '' }
  }
}
