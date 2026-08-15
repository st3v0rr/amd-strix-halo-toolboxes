#!/usr/bin/env node
/**
 * Dev runner: starts the API in mock mode and Vite side by side.
 *
 * Mock mode is a config swap rather than a code branch — every external binary
 * is looked up through lib/exec.js, so pointing those env vars at the shims in
 * dev/bin is all it takes to run the whole app on a machine with no podman, no
 * hf and no GPU.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(here, '..')
const tmp = path.join(here, 'tmp')

fs.mkdirSync(tmp, { recursive: true })
fs.mkdirSync(path.join(tmp, 'config'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })

const env = {
  ...process.env,
  SHX_MOCK: '1',
  SHX_PODMAN_BIN: path.join(here, 'bin', 'podman'),
  SHX_HF_BIN: path.join(here, 'bin', 'hf'),
  SHX_FIREWALL_CMD_BIN: path.join(here, 'bin', 'firewall-cmd'),
  SHX_MOCK_FIREWALL_STATE: path.join(tmp, 'firewalld.json'),
  SHX_SYSFS_ROOT: path.join(here, 'sysfs'),
  SHX_PROC_ROOT: path.join(tmp, 'proc'),
  SHX_CONFIG_DIR: path.join(tmp, 'config'),
  SHX_STATE_DIR: path.join(tmp, 'state'),
  SHX_LOG_LEVEL: process.env.SHX_LOG_LEVEL || 'debug',
  SHX_MOCK_HELP_VARIANT: process.env.SHX_MOCK_HELP_VARIANT || 'new',
}

/**
 * A `/proc/net/dev` that actually moves.
 *
 * The interfaces themselves are fixtures under `dev/sysfs/class/net`, but
 * throughput only exists as the difference between two reads — a static file
 * would show every link at exactly 0 B/s. So the counters are advanced here
 * once a second, with the Thunderbolt link bursting the way an RPC transfer
 * does and the others trickling along.
 */
const procNetDev = path.join(tmp, 'proc', 'net', 'dev')
const netCounters = {
  enp3s0: { rx: 4_000_000_000, tx: 900_000_000, rate: 120_000 },
  thunderbolt0: { rx: 91_000_000_000, tx: 88_000_000_000, rate: 900_000_000, bursty: true },
  wlp1s0: { rx: 300_000_000, tx: 40_000_000, rate: 8_000 },
  'cni-podman0': { rx: 12_000_000, tx: 9_000_000, rate: 2_000 },
}
let netTick = 0

function writeProcNetDev() {
  netTick += 1
  const lines = [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 1200  12 0 0 0 0 0 0 1200  12 0 0 0 0 0 0',
  ]
  for (const [name, state] of Object.entries(netCounters)) {
    // A sine over the tick count, so the sparklines have a shape instead of a
    // flat line; the Thunderbolt link idles between bursts.
    const wave = state.bursty
      ? Math.max(0, Math.sin(netTick / 8)) ** 2
      : 0.6 + 0.4 * Math.sin(netTick / 5)
    const rx = Math.round(state.rate * wave)
    const tx = Math.round(rx * 0.35)
    state.rx += rx
    state.tx += tx
    const packets = Math.round(rx / 1500)
    lines.push(
      `${name.padStart(9)}: ${state.rx} ${packets} 0 0 0 0 0 0 ${state.tx} ${Math.round(packets * 0.4)} 0 0 0 0 0 0`,
    )
  }
  fs.writeFileSync(procNetDev, lines.join('\n') + '\n')
}

fs.mkdirSync(path.dirname(procNetDev), { recursive: true })
writeProcNetDev()
setInterval(writeProcNetDev, 1000)

// A small model tree for the scanner to find. Generated rather than committed:
// these are megabytes of zeroes whose only job is to have a plausible name,
// a size and a shard suffix.
const modelsDir = path.join(here, 'models')
const SEED_MODELS = [
  ['Qwen3.6-27B-GGUF/Q8_0/Qwen3.6-27B-Q8_0.gguf', 3_000_000],
  ['gpt-oss-120b-GGUF/F16/gpt-oss-120b-F16-00001-of-00003.gguf', 2_000_000],
  ['gpt-oss-120b-GGUF/F16/gpt-oss-120b-F16-00002-of-00003.gguf', 2_000_000],
  ['gpt-oss-120b-GGUF/F16/gpt-oss-120b-F16-00003-of-00003.gguf', 2_000_000],
]
for (const [rel, size] of SEED_MODELS) {
  const file = path.join(modelsDir, rel)
  if (fs.existsSync(file)) continue
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(size))
}

const configFile = path.join(tmp, 'config', 'config.json')
if (!fs.existsSync(configFile)) {
  const { hashPassword } = await import('../server/src/auth/password.js')
  const { generateSecret } = await import('../server/src/auth/tokens.js')
  const config = {
    version: 1,
    username: 'admin',
    passwordHash: await hashPassword('devdev'),
    jwtSecret: generateSecret(),
    hfToken: '',
    settings: {
      modelsDir: path.join(here, 'models'),
      bindAddress: '127.0.0.1',
      port: 8420,
    },
  }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 })
  process.stdout.write('\n  Dev-Zugang angelegt: admin / devdev\n\n')
}

const children = []
function start(name, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: webuiRoot,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const prefix = `[${name}] `
  const pipe = (stream, out) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      for (const line of chunk.split('\n')) if (line.trim()) out.write(prefix + line + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    process.stderr.write(`${prefix}beendet (${code})\n`)
    shutdown()
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

start('api', process.execPath, ['--watch', 'server/src/index.js'])
start('web', 'npm', ['run', 'dev', '--workspace', 'web'])

process.stdout.write('\n  UI:  http://127.0.0.1:5173\n  API: http://127.0.0.1:8420\n\n')
