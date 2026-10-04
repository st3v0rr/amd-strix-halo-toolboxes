/**
 * The media API routes end to end: a real context and app on a random port,
 * podman replaced by dev/bin/podman (which answers `media-api-models` from
 * dev/fixtures/media-registry.json against the real mounted directory).
 *
 * Everything runs in a temp directory set up before the app's modules load,
 * because the config paths are fixed at import.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-media-routes-'))
Object.assign(process.env, {
  SHX_CONFIG_DIR: path.join(root, 'config'),
  SHX_STATE_DIR: path.join(root, 'state'),
  SHX_MOCK: '1',
  SHX_PODMAN_BIN: 'dev/bin/podman',
  SHX_MOCK_STATE: path.join(root, 'podman-state.json'),
  SHX_LOG_LEVEL: 'error',
})

const { createContext } = await import('../src/context.js')
const { createApp } = await import('../src/app.js')
const { signToken } = await import('../src/auth/tokens.js')
const { generateApiToken, hashApiToken } = await import('../src/auth/apitoken.js')
const { loopbackUrl } = await import('../src/mcp/routes.js')
const { reconcile } = await import('../src/podman/autostart.js')
const { createMediaSecrets } = await import('../src/media/secrets.js')

const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const mediaModels = path.join(root, 'media-models')
const dataDir = path.join(root, 'media-data')

let ctx
let server
let base
let session
let token
let mediaPort
/** Every response body, to prove afterwards that no secret was ever in one. */
const seen = []

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function call(method, p, { body, auth = 'session' } = {}) {
  const headers = { Accept: 'application/json' }
  if (auth === 'session') headers.Cookie = `shx_token=${session}`
  if (auth === 'token') headers.Authorization = `Bearer ${token}`
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'shx'
    headers.Origin = base
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  seen.push(text)
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const api = (method, p, opts) => call(method, `/api${p}`, opts)

async function waitForJob(id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { body } = await api('GET', `/jobs/${id}`)
    if (['done', 'failed', 'cancelled', 'interrupted'].includes(body.job.status)) return body
    if (Date.now() > deadline) throw new Error(`job ${id} hängt: ${JSON.stringify(body.job)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

before(async () => {
  ctx = createContext()
  token = generateApiToken()
  await ctx.config.update((c) => {
    c.jwtSecret = Buffer.alloc(32, 7).toString('base64')
    c.apiToken = { hash: hashApiToken(token), hint: 'x', createdAt: new Date().toISOString() }
    c.settings.mediaModelsDir = mediaModels
    return c
  })
  mediaPort = await freePort()
  await ctx.media.update((m) => ({ ...m, dataDir, backend: 'mock', port: mediaPort }))
  session = await signToken(ctx.config.data.jwtSecret, { sub: 'admin' })
  const app = createApp(ctx)
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  ctx.selfUrl = loopbackUrl(server.address())
  base = ctx.selfUrl
})

after(async () => {
  server?.closeAllConnections?.()
  await new Promise((resolve) => server?.close(resolve))
  await Promise.all([ctx.config.flush(), ctx.state.flush(), ctx.media.flush(), ctx.profiles.flush()])
})

test('the status starts from safe defaults, with no Podman mode of its own', async () => {
  const { status, body } = await api('GET', '/media')
  assert.equal(status, 200)
  assert.equal(body.config.name, 'media-api')
  assert.equal(body.config.bindAddress, '127.0.0.1')
  assert.equal(body.config.modelsReadOnly, true)
  assert.equal(body.config.allowDownloads, false)
  assert.equal(body.effective.modelsDir, mediaModels, 'the general media tree by default')
  assert.equal(body.container, null)
  assert.equal(body.image.installed, true)
  assert.equal(body.secrets.apiKey.configured, false)
  // No Podman mode of its own: nothing to report, nothing to switch.
  for (const field of ['runtime', 'rootless']) assert.equal(field in body, false, field)
  assert.equal('allowRootfulPodman' in body.config, false)
})

test('settings are validated as a whole before they are stored', async () => {
  const cases = [
    [{ allowDownloads: true }, /beschreibbaren/],
    [{ dataDir: os.homedir() }, /enthält/],
    [{ dataDir: 'relative' }, /absoluter Pfad/],
    [{ bindAddress: 'box.lan' }, /bindAddress/],
    [{ corsOrigins: ['*'] }, /corsOrigins/],
    [{ publicUrl: 'javascript:alert(1)' }, /publicUrl/],
    [{ port: 80 }, /port/],
    [{ limits: { maxSteps: 0 } }, /maxSteps/],
  ]
  for (const [patch, message] of cases) {
    const { status, body } = await api('PUT', '/media/config', { body: patch })
    assert.equal(status, 400, JSON.stringify(patch))
    assert.match(body.error.message, message)
  }
  const ok = await api('PUT', '/media/config', { body: { logLevel: 'debug', limits: { maxSteps: 60 } } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.config.logLevel, 'debug')
  assert.equal(ok.body.config.limits.maxSteps, 60)
  assert.equal(ok.body.config.port, mediaPort, 'unnamed settings stay')
  assert.ok(ok.body.config.updatedAt)
})

test('"Media API starten" creates the hardened rootful container and generates the secrets as files', async () => {
  // Exactly what the Servers page dialog sends when nothing is changed.
  const { status, body } = await api('POST', '/servers', {
    body: { role: 'media', name: 'media-api', port: mediaPort, bindAddress: '127.0.0.1', replace: false },
  })
  assert.equal(status, 201, JSON.stringify(body))
  assert.equal(body.role, 'media')
  const secretsDir = path.join(root, 'config', 'media-api')
  assert.equal(fs.statSync(secretsDir).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(secretsDir, 'api-key')).mode & 0o777, 0o600)
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700)

  const argv = JSON.parse(fs.readFileSync(path.join(webuiRoot, 'dev', 'tmp', 'last-run-argv.json'), 'utf8'))
  assert.ok(argv.includes('--cap-drop=all') && argv.includes('--security-opt=no-new-privileges'))
  assert.ok(!argv.includes('--userns=keep-id') && !argv.includes('keep-groups'), 'no rootless-only flags')
  assert.equal(argv[argv.indexOf('-p') + 1], `127.0.0.1:${mediaPort}:8000`)
  assert.ok(argv.includes(`${mediaModels}:/models:ro,z`))
  assert.ok(argv.some((a) => a.endsWith(':/run/secrets/media-api-key:ro,z')))
  assert.ok(!argv.includes('/dev/kfd'), 'mock backend: no GPU')

  // An ordinary member of the server list, with the ordinary lifecycle.
  const { body: servers } = await api('GET', '/servers')
  const media = servers.servers.find((s) => s.name === 'media-api')
  assert.equal(media.role, 'media')
  assert.equal(media.hostPort, mediaPort)
  assert.equal(media.bindAddress, '127.0.0.1')
  assert.equal(media.mediaModelsReadOnly, true)
  assert.equal('mediaRuntime' in media, false)
  // The settings the service's API reports still carry what the first test saved.
  assert.equal((await api('GET', '/media')).body.config.logLevel, 'debug')
})

/** New settings reach a container only by removing it explicitly and starting again. */
async function recreate() {
  assert.equal((await api('DELETE', '/servers/media-api')).status, 200)
  return api('POST', '/media/apply', { body: {} })
}

test('a second start is refused, never a replacement, and the status reports drift until re-created', async () => {
  const again = await api('POST', '/media/apply', { body: {} })
  assert.equal(again.status, 409)
  assert.equal(again.body.error.details.existing, 'media-api')
  const replace = await api('POST', '/media/apply', { body: { replace: true } })
  assert.equal(replace.status, 409, 'replace is refused as well')
  assert.equal(replace.body.error.details.removalRequired, true)

  let { body } = await api('GET', '/media')
  assert.equal(body.container.running, true)
  assert.deepEqual(body.drift, { config: false, secrets: false })
  assert.equal(body.health.reachable, false, 'nothing listens in mock mode')

  await api('PUT', '/media/config', { body: { logLevel: 'info' } })
  ;({ body } = await api('GET', '/media'))
  assert.equal(body.drift.config, true)

  assert.equal((await recreate()).status, 201)
  ;({ body } = await api('GET', '/media'))
  assert.equal(body.drift.config, false)
})

test('secrets change only from a browser session, and only by fingerprint', async () => {
  const keyFile = path.join(root, 'config', 'media-api', 'api-key')
  const before = fs.readFileSync(keyFile, 'utf8')

  for (const [method, p, body] of [
    ['POST', '/media/secrets/api-key'],
    ['PUT', '/media/secrets/api-key', { value: 'agent-chosen-key-0123456789' }],
    ['POST', '/media/secrets/session-secret'],
  ]) {
    const res = await api(method, p, { body, auth: 'token' })
    assert.equal(res.status, 403, `${method} ${p} with the API token`)
  }
  assert.equal(fs.readFileSync(keyFile, 'utf8'), before)

  assert.equal((await api('PUT', '/media/secrets/api-key', { body: { value: 'changeme' } })).status, 400)
  assert.equal((await api('PUT', '/media/secrets/api-key', { body: { value: 'with space 0123456789' } })).status, 400)

  await new Promise((r) => setTimeout(r, 20))
  const rotated = await api('POST', '/media/secrets/api-key')
  assert.equal(rotated.status, 200)
  assert.equal(rotated.body.restartRequired, true)
  assert.match(rotated.body.secrets.apiKey.fingerprint, /^[0-9a-f]{12}$/)
  const after = fs.readFileSync(keyFile, 'utf8')
  assert.notEqual(after, before)
  assert.ok(!JSON.stringify(rotated.body).includes(after.trim()))

  const { body } = await api('GET', '/media')
  assert.equal(body.drift.secrets, true, 'the running container still has the old key')
  assert.equal(body.service, null, 'no authenticated probe with a key the service does not know')

  assert.equal((await api('POST', '/servers/media-api/restart')).status, 200)
  assert.equal((await api('GET', '/media')).body.drift.secrets, false)
})

test('the inventory comes from the image inside the running container, curated models only', async () => {
  const { status, body } = await api('GET', '/media/models')
  assert.equal(status, 200, JSON.stringify(body))
  assert.equal(body.source, 'container')
  // The fixture registry also reports a stray model; it is neither listed…
  assert.deepEqual(body.models.map((m) => m.id), ['qwen-image-2512', 'qwen-image-edit-2511', 'minimax-h3'])
  // …nor fetchable.
  const stray = await api('POST', '/media/fetch', { body: { model: 'stray-model' } })
  assert.equal(stray.status, 404)
  assert.match(stray.body.error.message, /stray-model/)
  const qwen = body.models.find((m) => m.id === 'qwen-image-2512')
  const fp8 = qwen.profiles.find((p) => p.id === 'fp8')
  assert.equal(fp8.available, false)
  assert.ok(fp8.missing.length > 0)
  assert.match(qwen.profiles.find((p) => p.id === 'nf4-bitsandbytes').reason, /bitsandbytes/)
})

test('fetch validates against the inventory, runs one at a time and reports progress', async () => {
  assert.equal((await api('POST', '/media/fetch', { body: { model: 'nope' } })).status, 404)
  assert.equal((await api('POST', '/media/fetch', { body: { model: 'qwen-image-2512', profile: 'nf4-bitsandbytes' } })).status, 400)
  assert.equal((await api('POST', '/media/fetch', { body: { model: '../etc' } })).status, 400)
  assert.equal(
    (await api('POST', '/media/fetch', { body: { model: 'minimax-h3', profile: 'int8', task: 'image-edit' } })).status,
    400,
  )

  const started = await api('POST', '/media/fetch', { body: { model: 'qwen-image-2512', profile: 'fp8' } })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  const busy = await api('POST', '/media/fetch', { body: { model: 'qwen-image-edit-2511' } })
  assert.equal(busy.status, 409)
  assert.equal(busy.body.error.details.jobId, started.body.jobId)

  const done = await waitForJob(started.body.jobId)
  assert.equal(done.job.status, 'done', JSON.stringify(done.job))
  assert.equal(done.job.progress.pct, 100)
  assert.equal(done.job.progress.files.done, 3)
  assert.equal(done.job.type, 'media-model-fetch')
  assert.ok(fs.existsSync(path.join(mediaModels, 'diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors')))

  const { body } = await api('GET', '/media/models')
  const fp8 = body.models.find((m) => m.id === 'qwen-image-2512').profiles.find((p) => p.id === 'fp8')
  assert.equal(fp8.available, true, 'the cache was dropped when the fetch finished')
  const again = await api('POST', '/media/fetch', { body: { model: 'qwen-image-2512', profile: 'fp8' } })
  assert.equal(again.status, 409)
  assert.match(again.body.error.message, /bereits vollständig/)
})

test('a finished fetch can be resumed, a running one cannot', async () => {
  const started = await api('POST', '/media/fetch', { body: { model: 'minimax-h3', task: 'text-to-video' } })
  assert.equal(started.status, 202)
  assert.equal((await api('POST', `/media/fetch/${started.body.jobId}/resume`)).status, 409)
  assert.equal((await api('DELETE', `/jobs/${started.body.jobId}`)).status, 200)
  const cancelled = await waitForJob(started.body.jobId)
  assert.equal(cancelled.job.status, 'cancelled')

  const resumed = await api('POST', `/media/fetch/${started.body.jobId}/resume`)
  assert.equal(resumed.status, 202, JSON.stringify(resumed.body))
  const done = await waitForJob(resumed.body.jobId)
  assert.equal(done.job.status, 'done', JSON.stringify(done.job))
  assert.equal(done.job.meta.task, 'text-to-video')
})

test('start, stop, logs and health go through the ordinary container routes', async () => {
  assert.equal((await api('POST', '/servers/media-api/stop')).body.server.running, false)
  assert.equal((await api('GET', '/media')).body.container.running, false)
  const inventory = await api('POST', '/media/models/refresh')
  assert.equal(inventory.body.source, 'image', 'a stopped service is checked with a throwaway container')
  assert.equal((await api('POST', '/servers/media-api/start')).body.server.running, true)
  const health = await api('GET', '/servers/media-api/health')
  assert.equal(health.body.role, 'media')
  assert.equal((await api('GET', '/servers/media-api/logs?tail=20')).status, 200)
  assert.equal((await api('GET', '/servers/media-api/profile-draft')).status, 400)
})

test('an agent reaches the media API through MCP, and never its key', async () => {
  const rpc = async (name, args = {}) => {
    const res = await call('POST', '/mcp', {
      auth: 'token',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    })
    return { ...res.body.result, data: JSON.parse(res.body.result.content[0].text) }
  }
  const status = await rpc('get_media_api')
  assert.equal(status.isError, false)
  assert.equal(status.data.container.name, 'media-api')
  const models = await rpc('list_media_models')
  assert.ok(models.data.models.length >= 3)
  const configured = await rpc('configure_media_api', { limits: { maxQueuedJobs: 4 } })
  assert.equal(configured.data.config.limits.maxQueuedJobs, 4)
  assert.equal(configured.data.config.limits.maxSteps, 60, 'a limit not named stays')
})

const sha = (v) => createHash('sha256').update(v).digest('hex')
const hfTokens = []

test('two fetch requests at once: one job, one refusal', async () => {
  const [a, b] = await Promise.all([
    api('POST', '/media/fetch', { body: { model: 'qwen-image-edit-2511' } }),
    api('POST', '/media/fetch', { body: { model: 'qwen-image-2512', profile: 'lightning-4step' } }),
  ])
  assert.deepEqual([a.status, b.status].sort(), [202, 409])
  const winner = a.status === 202 ? a : b
  assert.equal((await waitForJob(winner.body.jobId)).job.status, 'done')
})

test('with the models moved, inventory and fetch follow the saved settings, not the running container', async () => {
  const moved = path.join(root, 'moved-models')
  assert.equal((await api('PUT', '/media/config', { body: { modelsDir: moved } })).status, 200)
  const inv = await api('GET', '/media/models')
  assert.equal(inv.status, 200, JSON.stringify(inv.body))
  assert.equal(inv.body.source, 'image', 'not the container, which still mounts the old tree')
  assert.equal(inv.body.modelsDir, path.join(fs.realpathSync(root), 'moved-models'))
  assert.equal(inv.body.running.modelsDir, fs.realpathSync(mediaModels))
  const fp8 = inv.body.models.find((m) => m.id === 'qwen-image-2512').profiles.find((p) => p.id === 'fp8')
  assert.equal(fp8.available, false, 'judged by the new, empty tree')
  const started = await api('POST', '/media/fetch', { body: { model: 'qwen-image-2512', profile: 'fp8' } })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  assert.equal(started.body.job.meta.modelsDir, inv.body.modelsDir)
  assert.equal((await waitForJob(started.body.jobId)).job.status, 'done')
  assert.ok(fs.existsSync(path.join(moved, 'diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors')))
  assert.equal((await api('GET', '/media')).body.drift.config, true)

  assert.equal((await api('PUT', '/media/config', { body: { modelsDir: '' } })).status, 200)
  const back = await api('GET', '/media/models')
  assert.equal(back.body.source, 'container')
  assert.equal(back.body.running, null)
})

test('a symlinked directory is refused on save and never mounted', async () => {
  fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true })
  fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'linked-data'))
  const res = await api('PUT', '/media/config', { body: { dataDir: path.join(root, 'linked-data') } })
  assert.equal(res.status, 400)
  assert.match(res.body.error.message, /symbolischer Link/)
})

test('the Hugging Face token: a file per fetch, and changes reach a running service at once', async () => {
  const secretsDir = path.join(root, 'config', 'media-api')
  const first = 'hf_first_test_token_0123456789abcd'
  const second = 'hf_second_test_token_987654321xyz'
  hfTokens.push(first, second)
  assert.equal((await api('PUT', '/settings', { body: { hfToken: first } })).status, 200)

  const started = await api('POST', '/media/fetch', { body: { model: 'qwen-image-2512', profile: 'gguf-q4km' } })
  assert.equal(started.status, 202, JSON.stringify(started.body))
  assert.equal((await waitForJob(started.body.jobId)).job.status, 'done')
  const shot = JSON.parse(fs.readFileSync(path.join(root, 'media-oneshot.json'), 'utf8'))
  assert.ok(shot.argv.includes('HF_TOKEN_PATH=/run/secrets/hf-token'))
  assert.ok(shot.argv.some((a) => /\/fetch-[A-Za-z0-9]+\.token:\/run\/secrets\/hf-token:ro,z$/.test(a)))
  assert.ok(!shot.argv.some((a) => a.includes(first) || a === 'HF_TOKEN' || a.startsWith('HF_TOKEN=')))
  assert.equal(shot.hfTokenInEnv, false, 'podman itself never saw the token in its environment')
  assert.equal(shot.tokenSha, sha(first), 'the container read it from the mounted file')
  assert.deepEqual(fs.readdirSync(secretsDir).filter((f) => f.startsWith('fetch-')), [], 'the copy is gone')

  assert.equal((await api('PUT', '/media/config', { body: { allowDownloads: true, modelsReadOnly: false } })).status, 200)
  assert.equal((await recreate()).status, 201)
  const tokenFile = path.join(secretsDir, 'hf-token', 'token')
  const inode = fs.statSync(tokenFile).ino
  let status = (await api('GET', '/media')).body
  assert.equal(status.secrets.hfToken, 'active')
  assert.equal(status.drift.config, false)

  await api('PUT', '/settings', { body: { hfToken: second } })
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), second)
  assert.notEqual(fs.statSync(tokenFile).ino, inode, 'atomic rename is visible through the mounted directory')
  const secondInode = fs.statSync(tokenFile).ino
  status = (await api('GET', '/media')).body
  assert.equal(status.drift.config, false, 'a rotated token needs no re-creation')

  await api('DELETE', '/settings/hf-token')
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), '', 'revoked at once')
  assert.notEqual(fs.statSync(tokenFile).ino, secondInode)
  status = (await api('GET', '/media')).body
  assert.equal(status.secrets.hfToken, 'revoked')
  assert.equal(status.drift.config, true, 'the mount itself goes with the next apply')

  assert.equal((await api('PUT', '/media/config', { body: { allowDownloads: false, modelsReadOnly: true } })).status, 200)
  assert.equal((await recreate()).status, 201)
  assert.equal(fs.existsSync(tokenFile), false)
})

test('autostart brings the service back when its container is gone', async () => {
  assert.equal((await api('DELETE', '/servers/media-api')).status, 200)
  await ctx.media.update((m) => ({ ...m, autostart: true }))
  const result = await reconcile(ctx, { stagger: 0 })
  assert.deepEqual(result.started, [{ name: 'media-api', action: 'neu angelegt' }])
  assert.deepEqual(result.failed, [])
})

test('no secret ever left the box: not in a response, not in podman', () => {
  const secretsDir = path.join(root, 'config', 'media-api')
  const values = [
    ...['api-key', 'session-secret'].map((f) => fs.readFileSync(path.join(secretsDir, f), 'utf8').trim()),
    ...hfTokens,
  ]
  const podmanState = fs.readFileSync(process.env.SHX_MOCK_STATE, 'utf8')
  for (const value of values) {
    assert.ok(value.length >= 32)
    assert.ok(!seen.some((text) => text.includes(value)), 'a response carried a secret')
    assert.ok(!podmanState.includes(value), 'a secret reached podman')
  }
})

test('with custom images off, only the media image gets mounts, network or a token', async () => {
  const evil = 'docker.io/st3v0rr/amd-strix-halo-toolboxes:vulkan-radv'
  const refused = await api('PUT', '/media/config', { body: { image: evil } })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error.message, /Media-API-Image/)
  await api('PUT', '/settings', { body: { allowCustomImages: true } })
  assert.equal((await api('PUT', '/media/config', { body: { image: evil } })).status, 200)
  assert.equal((await recreate()).status, 201)
  await api('PUT', '/settings', { body: { allowCustomImages: false } })
  try {
    for (const [method, p, body] of [
      ['GET', '/media/models'],
      ['POST', '/media/models/refresh'],
      ['POST', '/media/fetch', { model: 'qwen-image-2512', profile: 'gguf-q4km' }],
      ['POST', '/media/apply', {}],
    ]) {
      const res = await api(method, p, { body })
      assert.equal(res.status, 400, `${method} ${p}`)
      assert.match(res.body.error.message, /Media-API-Image/)
    }

    assert.equal((await api('POST', '/servers/media-api/stop')).status, 200)
    assert.equal((await api('POST', '/servers/media-api/start')).status, 400, 'HTTP start rechecks the container image')
    const mcp = await call('POST', '/mcp', {
      auth: 'token',
      body: { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'start_server', arguments: { name: 'media-api' } } },
    })
    assert.equal(mcp.body.result.isError, true, 'MCP reaches the same lifecycle policy')
    assert.match(mcp.body.result.content[0].text, /Media-API-Image/)
    const auto = await reconcile(ctx, { stagger: 0 })
    assert.match(auto.failed.find((f) => f.name === 'media-api')?.error ?? '', /Media-API-Image/)

    await api('PUT', '/settings', { body: { allowCustomImages: true } })
    assert.equal((await api('POST', '/servers/media-api/start')).status, 200)
    await api('PUT', '/settings', { body: { allowCustomImages: false } })
    assert.equal((await api('POST', '/servers/media-api/restart')).status, 400)
    assert.equal((await api('GET', '/servers/media-api')).body.server.running, true, 'restart refuses before stop')
  } finally {
    await api('PUT', '/settings', { body: { allowCustomImages: true } })
    await api('PUT', '/media/config', { body: { image: 'docker.io/st3v0rr/amd-strix-halo-toolboxes:media-api' } })
    await api('DELETE', '/servers/media-api')
    await api('POST', '/media/apply', { body: {} })
    await api('PUT', '/settings', { body: { allowCustomImages: false } })
  }
  assert.equal((await api('GET', '/media/models')).status, 200, 'the approved image still works')
  assert.equal((await api('GET', '/media')).body.container.running, true, 'running again, on the approved image')
})

test('a mount source swapped between check and start is caught; the container never runs', async () => {
  assert.equal((await api('DELETE', '/servers/media-api')).status, 200)
  process.env.SHX_MOCK_SWAP_ON_CREATE = dataDir
  let res
  try {
    res = await api('POST', '/media/apply', { body: {} })
  } finally {
    delete process.env.SHX_MOCK_SWAP_ON_CREATE
  }
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.match(res.body.error.message, /ersetzt/)
  assert.equal((await api('GET', '/servers')).body.servers.some((s) => s.name === 'media-api'), false)
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.renameSync(`${dataDir}.orig`, dataDir)
  assert.equal((await api('POST', '/media/apply', { body: {} })).status, 201)
})


test('the Servers-page start: few choices, stored only once the container runs, exposed only on request', async () => {
  const stored = () => ctx.media.data
  const lastArgv = () => JSON.parse(fs.readFileSync(path.join(webuiRoot, 'dev', 'tmp', 'last-run-argv.json'), 'utf8'))

  // A bad choice is named rather than drowned in "no variant matched".
  const bad = await api('POST', '/servers', { body: { role: 'media', bindAddress: 'box.lan' } })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error.message, /bindAddress/)

  // One service per box: an existing one is refused — asked to replace it or
  // not — and a refused start stores nothing and leaves the container alone.
  const before = JSON.parse(JSON.stringify(stored()))
  for (const replace of [false, true]) {
    const taken = await api('POST', '/servers', { body: { role: 'media', bindAddress: '0.0.0.0', replace } })
    assert.equal(taken.status, 409, `replace: ${replace}`)
    assert.equal(taken.body.error.details.existing, 'media-api')
    assert.equal(taken.body.error.details.removalRequired, true)
  }
  assert.deepEqual(stored(), before)
  assert.equal((await api('GET', '/servers/media-api')).body.server.running, true, 'the old container was left alone')

  // Removed explicitly, as the dialog asks. A port another process holds is
  // then refused before anything is created.
  assert.equal((await api('DELETE', '/servers/media-api')).status, 200)
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen({ port: 0, host: '0.0.0.0' }, resolve))
  try {
    const busy = await api('POST', '/servers', { body: { role: 'media', port: blocker.address().port } })
    assert.equal(busy.status, 409, JSON.stringify(busy.body))
    assert.match(busy.body.error.message, /belegt/)
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
  assert.deepEqual(stored(), before, 'still nothing stored')
  assert.equal((await api('GET', '/servers')).body.servers.some((s) => s.role === 'media'), false, 'nothing created')

  // What the dialog does with a key of one's own and "Im Netzwerk erreichbar":
  // the key on its own browser-only route first, then the start.
  const chosenKey = 'my-own-media-client-key-0123456789abcdef'
  assert.equal((await api('PUT', '/media/secrets/api-key', { body: { value: chosenKey } })).status, 200)
  const exposed = await api('POST', '/servers', {
    body: { role: 'media', name: 'media-api', port: mediaPort, bindAddress: '0.0.0.0', replace: false },
  })
  assert.equal(exposed.status, 201, JSON.stringify(exposed.body))
  let argv = lastArgv()
  assert.equal(argv[argv.indexOf('-p') + 1], `0.0.0.0:${mediaPort}:8000`)
  assert.ok(!argv.includes('--userns=keep-id') && !argv.includes('keep-groups'), 'rootful: no rootless-only flags')
  for (const value of ['--cap-drop=all', '--security-opt=no-new-privileges', `${mediaModels}:/models:ro,z`]) {
    assert.ok(argv.includes(value), value)
  }
  const keyFile = path.join(root, 'config', 'media-api', 'api-key')
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), chosenKey, 'the new container mounts the chosen key')
  assert.equal(stored().bindAddress, '0.0.0.0', 'stored once the container runs')
  // Autostart is not a start choice: it is set on its own, like a profile's.
  assert.equal(stored().autostart, before.autostart, 'a start never touches autostart')
  assert.equal((await api('PUT', '/media/config', { body: { autostart: true } })).status, 200)
  assert.equal(stored().autostart, true)
  const status = (await api('GET', '/media')).body
  assert.deepEqual(status.drift, { config: false, secrets: false }, 'autostart is not part of the container')
  assert.ok(!status.warnings.some((w) => /unverschlüsselt/.test(w.text)), 'the network is a normal choice')
  const listed = (await api('GET', '/servers')).body.servers.find((s) => s.name === 'media-api')
  assert.equal(listed.bindAddress, '0.0.0.0')
  assert.equal(listed.running, true)

  // The same through MCP, back to loopback; autostart stays as it was set.
  // MCP cannot replace either: only delete_server, then create_media_api again.
  const mcpCall = (id, name, args) =>
    call('POST', '/mcp', { auth: 'token', body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } })
  const refused = await mcpCall(31, 'create_media_api', { bindAddress: '127.0.0.1' })
  assert.equal(refused.body.result.isError, true, 'a running media API is never replaced')
  assert.equal((await mcpCall(32, 'delete_server', { name: 'media-api' })).body.result.isError, false)
  const mcp = await mcpCall(33, 'create_media_api', { bindAddress: '127.0.0.1' })
  assert.equal(mcp.body.result.isError, false, JSON.stringify(mcp.body))
  argv = lastArgv()
  assert.equal(argv[argv.indexOf('-p') + 1], `127.0.0.1:${mediaPort}:8000`)
  assert.equal(stored().bindAddress, '127.0.0.1')
  assert.equal(stored().autostart, true)
  assert.equal((await mcpCall(34, 'configure_media_api', { autostart: false })).body.result.isError, false)
  assert.equal(stored().autostart, false)

  // The ordinary lifecycle, with no Podman mode to ask about.
  assert.equal((await api('POST', '/servers/media-api/stop')).body.server.running, false)
  assert.equal((await api('POST', '/servers/media-api/start')).body.server.running, true)
  assert.equal((await api('POST', '/servers/media-api/restart')).body.server.running, true)
  assert.ok(!seen.some((text) => text.includes(chosenKey)), 'the chosen key never came back out')
})

function failNextTokenDirectorySync() {
  let syncs = 0
  const io = Object.create(fs)
  io.fsyncSync = (fd) => {
    syncs += 1
    if (syncs === 2) throw Object.assign(new Error('injected token directory fsync failure'), { code: 'EIO' })
    fs.fsyncSync(fd)
  }
  return io
}

function failNextConfigDirectorySync(directory) {
  let armed = true
  return {
    mkdir: fsp.mkdir.bind(fsp),
    rename: fsp.rename.bind(fsp),
    rm: fsp.rm.bind(fsp),
    async open(target, flags, mode) {
      const handle = await fsp.open(target, flags, mode)
      if (target !== directory) return handle
      return {
        close: () => handle.close(),
        async sync() {
          if (armed) {
            armed = false
            throw Object.assign(new Error('injected config directory fsync failure'), { code: 'EIO' })
          }
          return handle.sync()
        },
      }
    },
  }
}

test('token directory fsync failures roll back updates and deletes and remain retryable', async () => {
  const { redact } = await import('../src/lib/redact.js')
  const tokenFile = path.join(root, 'config', 'media-api', 'hf-token', 'token')
  const oldToken = 'hf_token_fsync_old_0123456789ab'
  const newToken = 'hf_token_fsync_new_0123456789ab'
  ctx.mediaSecrets.syncHfToken(oldToken)
  assert.equal((await api('PUT', '/settings', { body: { hfToken: oldToken } })).status, 200)
  const realSecrets = ctx.mediaSecrets
  try {
    ctx.mediaSecrets = createMediaSecrets(path.join(root, 'config', 'media-api'), failNextTokenDirectorySync())
    assert.equal((await api('PUT', '/settings', { body: { hfToken: newToken } })).status, 424)
    assert.equal(ctx.config.data.hfToken, oldToken)
    assert.equal(JSON.parse(fs.readFileSync(ctx.config.file, 'utf8')).hfToken, oldToken)
    assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), oldToken)
    assert.equal(redact(newToken), '***', 'a failed candidate is still redacted')

    ctx.mediaSecrets = realSecrets
    assert.equal((await api('PUT', '/settings', { body: { hfToken: newToken } })).status, 200)
    ctx.mediaSecrets = createMediaSecrets(path.join(root, 'config', 'media-api'), failNextTokenDirectorySync())
    assert.equal((await api('DELETE', '/settings/hf-token')).status, 424)
    assert.equal(ctx.config.data.hfToken, newToken)
    assert.equal(JSON.parse(fs.readFileSync(ctx.config.file, 'utf8')).hfToken, newToken)
    assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), newToken)

    ctx.mediaSecrets = realSecrets
    assert.equal((await api('DELETE', '/settings/hf-token')).status, 200)
    assert.equal(fs.readFileSync(tokenFile, 'utf8'), '')
  } finally {
    ctx.mediaSecrets = realSecrets
  }
})

test('config directory fsync failures after rename roll back update and delete without acknowledging them', async () => {
  const tokenFile = path.join(root, 'config', 'media-api', 'hf-token', 'token')
  const oldToken = 'hf_config_fsync_old_0123456789'
  const newToken = 'hf_config_fsync_new_0123456789'
  ctx.mediaSecrets.syncHfToken(oldToken)
  assert.equal((await api('PUT', '/settings', { body: { hfToken: oldToken } })).status, 200)
  const realIo = ctx.config.io
  try {
    ctx.config.io = failNextConfigDirectorySync(path.dirname(ctx.config.file))
    assert.equal((await api('PUT', '/settings', { body: { hfToken: newToken } })).status, 500)
    assert.equal(ctx.config.data.hfToken, oldToken)
    assert.equal(JSON.parse(fs.readFileSync(ctx.config.file, 'utf8')).hfToken, oldToken)
    assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), oldToken)

    ctx.config.io = realIo
    assert.equal((await api('PUT', '/settings', { body: { hfToken: newToken } })).status, 200)

    ctx.config.io = failNextConfigDirectorySync(path.dirname(ctx.config.file))
    assert.equal((await api('DELETE', '/settings/hf-token')).status, 500)
    assert.equal(ctx.config.data.hfToken, newToken)
    assert.equal(JSON.parse(fs.readFileSync(ctx.config.file, 'utf8')).hfToken, newToken)
    assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), newToken)
  } finally {
    ctx.config.io = realIo
  }
  assert.equal((await api('DELETE', '/settings/hf-token')).status, 200)
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), '')
})

test('restart reconciles interrupted token updates and deletes from durable config before use', async () => {
  const tokenFile = path.join(root, 'config', 'media-api', 'hf-token', 'token')
  const durableToken = 'hf_restart_source_0123456789abcd'
  const interruptedToken = 'hf_restart_unacked_0123456789ab'
  ctx.mediaSecrets.syncHfToken(durableToken)
  assert.equal((await api('PUT', '/settings', { body: { hfToken: durableToken } })).status, 200)

  ctx.mediaSecrets.refreshHfToken(interruptedToken)
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), interruptedToken)
  const afterUpdateCrash = createContext()
  assert.equal(afterUpdateCrash.config.data.hfToken, durableToken)
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), durableToken)

  ctx.mediaSecrets.refreshHfToken(null)
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), '')
  const afterDeleteCrash = createContext()
  assert.equal(afterDeleteCrash.config.data.hfToken, durableToken)
  assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), durableToken)

  assert.equal((await api('DELETE', '/settings/hf-token')).status, 200)
})
