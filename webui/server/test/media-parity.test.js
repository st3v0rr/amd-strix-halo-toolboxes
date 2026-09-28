/**
 * Parity with the documented hardened command.
 *
 * toolboxes_media_api/README.md ("Run it") is the reference for how the media
 * API is meant to run: rootless with the user's UID, no capabilities, no
 * privilege escalation, the key as a read-only file, the model tree read-only.
 * This reads that very block and holds buildMediaRunArgv to every flag in it —
 * and to nothing beyond a short list of known additions, so a flag that weakens
 * the container cannot slip in on either side unnoticed.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { mediaConfigSchema } from '../src/config/schema.js'
import { buildMediaLabels } from '../src/podman/labels.js'
import { buildMediaRunArgv, mediaContainerEnv } from '../src/podman/argv.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const readme = fs.readFileSync(path.resolve(here, '../../../toolboxes_media_api/README.md'), 'utf8')

/** The `podman run` of the "Run it" block, continuation lines joined, split like a shell would. */
function documentedCommand() {
  const block = /## Run it[\s\S]*?```bash\n([\s\S]*?)```/.exec(readme)?.[1]
  assert.ok(block, 'README has a "Run it" bash block')
  const joined = block.replace(/\\\n/g, ' ')
  const line = joined.split('\n').find((l) => l.trim().startsWith('podman run'))
  assert.ok(line, 'the block contains a podman run')
  const tokens = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
  return tokens.slice(2) // drop "podman run"
}

/** Options as [flag, value] pairs, `--a=b` and `--a b` alike; the image last. */
function normalize(argv) {
  const VALUED = new Set(['--name', '--device', '--group-add', '--security-opt', '--cap-drop', '--userns', '-p', '-e', '-v', '--label', '--restart'])
  const pairs = []
  let i = 0
  while (i < argv.length - 1) {
    const token = argv[i]
    const eq = token.startsWith('--') ? token.indexOf('=') : -1
    if (eq > 0) {
      pairs.push([token.slice(0, eq), token.slice(eq + 1)])
      i += 1
    } else if (VALUED.has(token)) {
      pairs.push([token, argv[i + 1]])
      i += 2
    } else {
      pairs.push([token, null])
      i += 1
    }
  }
  return { pairs, image: argv[argv.length - 1] }
}

const home = '/home/someone'
const keyFile = `${home}/.config/strix-halo-webui/media-api/api-key`
const sessionFile = `${home}/.config/strix-halo-webui/media-api/session-secret`

/** The README's host paths, as the web interface would fill them in. */
function documentedPairs() {
  const { pairs, image } = normalize(documentedCommand())
  const mapped = pairs.map(([flag, value]) => [
    flag,
    value
      ?.replace('$HOME/.config/media-api/api-key', keyFile)
      .replace('$HOME/comfy-models', `${home}/comfy-models`)
      .replace('$HOME/media-api-data', `${home}/media-api-data`),
  ])
  return { pairs: mapped, image }
}

function ours(config = mediaConfigSchema.parse({})) {
  const spec = {
    containerName: config.name,
    image: config.image,
    hostPort: config.port,
    bindAddress: config.bindAddress,
    modelsDir: `${home}/comfy-models`,
    modelsReadOnly: config.modelsReadOnly,
    dataDir: `${home}/media-api-data`,
    backend: config.backend,
    allowDownloads: config.allowDownloads,
    secretFiles: { apiKey: keyFile, sessionSecret: sessionFile },
    env: mediaContainerEnv(config),
    specHash: 'x',
  }
  const argv = buildMediaRunArgv({ ...spec, labels: buildMediaLabels(spec) })
  assert.equal(argv[0], 'run')
  return normalize(argv.slice(1))
}

const key = ([flag, value]) => `${flag} ${value ?? ''}`.trim()

test('every flag of the documented hardened command is in ours', () => {
  const documented = documentedPairs()
  const built = ours()
  const have = new Set(built.pairs.map(key))
  for (const pair of documented.pairs) {
    assert.ok(have.has(key(pair)), `README verlangt "${key(pair)}", der Builder setzt es nicht`)
  }
  assert.equal(built.image, documented.image, 'same image by default')
})

test('ours adds nothing but restart policy, labels, service settings and the session secret', () => {
  const documented = new Set(documentedPairs().pairs.map(key))
  const extras = ours().pairs.filter((pair) => !documented.has(key(pair)))
  for (const [flag, value] of extras) {
    const allowed =
      (flag === '--restart' && value === 'unless-stopped') ||
      flag === '--label' ||
      (flag === '-e' && /^MEDIA_[A-Z_]+=/.test(value) && !/^MEDIA_(API_KEY|SESSION_SECRET)=/.test(value)) ||
      (flag === '-v' && value === `${sessionFile}:/run/secrets/media-api-session:ro,z`) ||
      (flag === '-d' && value === null)
    assert.ok(allowed, `unerwartete Zutat: ${flag} ${value ?? ''}`)
  }
})

test('the mock backend drops exactly the GPU part, nothing of the hardening', () => {
  const config = mediaConfigSchema.parse({ backend: 'mock' })
  const have = new Set(ours(config).pairs.map(key))
  for (const pair of documentedPairs().pairs) {
    const gpu = ['/dev/dri', '/dev/kfd', 'keep-groups', 'seccomp=unconfined'].includes(pair[1])
    assert.equal(have.has(key(pair)), !gpu, key(pair))
  }
})
