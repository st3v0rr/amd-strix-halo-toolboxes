#!/usr/bin/env node
/**
 * Parity, second half: the media API container's environment against the
 * service's real configuration loader.
 *
 * The first half (server/test/media-parity.test.js) holds the argv to the
 * documented hardened command. This one catches what that cannot: a variable
 * name the service does not know (it would silently ignore it), a value it
 * parses differently, or a range the web interface allows and the service
 * refuses — which would make the container exit 2 on start, in a loop.
 * Every limit is tried at both ends of the range the settings allow.
 *
 * Needs a Python with PyYAML: toolboxes_media_api/.venv if it exists, else
 * python3. Without one, it says so and skips rather than pretending.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MEDIA_LIMITS } from '../../shared/media.js'
import { mediaConfigSchema } from '../../server/src/config/schema.js'
import { mediaContainerEnv } from '../../server/src/podman/argv.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const mediaRoot = path.resolve(here, '../../../toolboxes_media_api')
const venvPython = path.join(mediaRoot, '.venv', 'bin', 'python')
const python = fs.existsSync(venvPython) ? venvPython : 'python3'

const limits = (pick) => Object.fromEntries(MEDIA_LIMITS.map((l) => [l.key, pick(l)]))
const CASES = [
  ['Standardeinstellungen', {}],
  [
    'Mock, alles umgeschaltet',
    {
      backend: 'mock',
      cookieSecure: true,
      allowXApiKey: false,
      disableMmap: false,
      logLevel: 'debug',
      sessionTtlHours: 1,
      corsOrigins: ['https://a.lan', 'http://b.lan:8080'],
    },
  ],
  ['Downloads, Speicherprüfung warn, Reserve 0', { allowDownloads: true, modelsReadOnly: false, memoryCheck: 'warn', memoryReserveGb: 0 }],
  ['Obergrenzen', { memoryReserveGb: 1024, sessionTtlHours: 720, limits: limits((l) => l.max) }],
  ['Untergrenzen', { memoryCheck: 'off', limits: limits((l) => l.min) }],
]

const cases = CASES.map(([label, patch]) => {
  const config = mediaConfigSchema.parse(patch)
  return { label, config, env: Object.fromEntries(mediaContainerEnv(config)) }
})

try {
  execFileSync(python, ['-c', 'import yaml'], { stdio: 'ignore' })
} catch {
  console.log(`  \x1b[33m–\x1b[0m Media-API-Parität übersprungen: kein Python mit PyYAML (${python}).`)
  process.exit(0)
}
// From here on a failure is a failure, not a missing tool.
const answers = JSON.parse(
  execFileSync(python, [path.join(here, 'media_env.py')], {
    input: JSON.stringify(cases.map((c) => ({ env: c.env }))),
    env: { ...process.env, MEDIA_API_SRC: path.join(mediaRoot, 'src') },
    encoding: 'utf8',
  }),
)

const expected = (config) => ({
  backend: config.backend,
  host: '0.0.0.0',
  port: 8000,
  models_dir: '/models',
  output_dir: '/data/outputs',
  upload_dir: '/data/uploads',
  state_dir: '/data/state',
  allow_downloads: config.allowDownloads,
  // config.py switches the check off for mock unless told otherwise, and we don't tell it.
  memory_check: config.backend === 'mock' ? 'off' : config.memoryCheck,
  disable_mmap: config.disableMmap,
  cookie_secure: config.cookieSecure,
  allow_x_api_key: config.allowXApiKey,
  cors_origins: config.corsOrigins,
  session_ttl_seconds: config.sessionTtlHours * 3600,
  log_level: config.logLevel,
})

const SNAKE = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

let failed = 0
for (const [i, { label, config }] of cases.entries()) {
  const answer = answers[i]
  const problems = []
  if (answer.unknown.length) problems.push(`unbekannte Variablen: ${answer.unknown.join(', ')}`)
  if (!answer.ok) {
    problems.push(`der Dienst lehnt ab: ${answer.error}`)
  } else {
    for (const [field, value] of Object.entries(expected(config))) {
      if (JSON.stringify(answer.settings[field]) !== JSON.stringify(value)) {
        problems.push(`${field}: erwartet ${JSON.stringify(value)}, Dienst liest ${JSON.stringify(answer.settings[field])}`)
      }
    }
    if (config.backend !== 'mock' && answer.settings.memory_reserve_gb !== config.memoryReserveGb) {
      problems.push(`memory_reserve_gb: ${answer.settings.memory_reserve_gb} statt ${config.memoryReserveGb}`)
    }
    for (const limit of MEDIA_LIMITS) {
      const value = config.limits[limit.key]
      const got = answer.settings.limits[SNAKE(limit.key)]
      if (value !== null && got !== value) problems.push(`${limit.env}: ${got} statt ${value}`)
    }
  }
  if (problems.length) {
    failed += 1
    console.log(`  \x1b[31m✗\x1b[0m Media API: ${label}`)
    for (const p of problems) console.log(`      ${p}`)
  } else {
    console.log(`  \x1b[32m✓\x1b[0m Media API: ${label}`)
  }
}
process.exit(failed ? 1 : 0)
