import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { LABEL, MEDIA_MODEL_DIRS, ROLE } from '../../shared/constants.js'
import {
  checkMediaApiKey,
  checkMediaSessionSecret,
  isIpv4,
  mediaConfigWarnings,
  mediaPlaygroundLink,
  mediaProfileState,
  parseOrigin,
  parsePublicUrl,
} from '../../shared/media.js'
import { mediaConfigSchema } from '../src/config/schema.js'
import { JsonStore } from '../src/config/store.js'
import { catalog } from '../src/images/catalog.js'
import { clearSecrets, redact } from '../src/lib/redact.js'
import {
  checkMediaConfig,
  checkMediaDir,
  ensureMediaDir,
  mediaSpec,
  pinMediaDir,
  trustedLink,
  verifyMediaMounts,
} from '../src/media/config.js'
import { explainCheckFailure, parseInventory } from '../src/media/models.js'
import { MediaFetchProgress, rateMeter } from '../src/media/progress.js'
import { createMediaSecrets } from '../src/media/secrets.js'
import { invalidateComfyModelCache, scanComfyModels } from '../src/models/comfyscan.js'
import {
  MEDIA_FETCH_LABEL,
  buildMediaCheckArgv,
  buildMediaExecCheckArgv,
  buildMediaFetchArgv,
  buildMediaRunArgv,
  mediaContainerEnv,
  mediaFetchContainer,
} from '../src/podman/argv.js'
import { buildMediaLabels, parseLabels } from '../src/podman/labels.js'
import { describeRole } from '../src/routes/network.js'

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix))
const defaults = () => mediaConfigSchema.parse({})

/* ------------------------------ shared/media.js ------------------------------ */

test('a key is judged by the service rules', () => {
  assert.equal(checkMediaApiKey('a'.repeat(16)), null)
  assert.match(checkMediaApiKey('short'), /16/)
  assert.match(checkMediaApiKey('has a space in it, long enough'), /Leerzeichen/)
  assert.match(checkMediaApiKey('replace-with-a-long-random-key'), /Platzhalter/)
  assert.match(checkMediaApiKey('CHANGEME'), /Platzhalter/)
  assert.match(checkMediaApiKey(''), /leer/)
  assert.match(checkMediaSessionSecret('x'.repeat(40), 'x'.repeat(40)), /unterscheiden/)
  assert.match(checkMediaSessionSecret('x'.repeat(31), 'k'.repeat(20)), /32/)
  assert.equal(checkMediaSessionSecret('x'.repeat(32), 'k'.repeat(20)), null)
})

test('addresses, origins and proxy URLs are parsed strictly', () => {
  assert.ok(isIpv4('127.0.0.1') && isIpv4('0.0.0.0') && isIpv4('10.7.7.2'))
  for (const bad of ['', '256.1.1.1', '01.2.3.4', '1.2.3', 'localhost', '::1']) assert.equal(isIpv4(bad), false, bad)
  assert.equal(parseOrigin('https://app.lan/'), 'https://app.lan')
  assert.equal(parseOrigin('http://app.lan:8080'), 'http://app.lan:8080')
  for (const bad of ['*', 'https://app.lan/path', 'ftp://x', 'https://u:p@app.lan', 'app.lan']) {
    assert.equal(parseOrigin(bad), null, bad)
  }
  assert.equal(parsePublicUrl('https://media.lan/'), 'https://media.lan')
  assert.equal(parsePublicUrl('https://box.lan/media/'), 'https://box.lan/media')
  assert.equal(parsePublicUrl('javascript:alert(1)'), null)
  assert.equal(parsePublicUrl('https://user:pw@box.lan'), null)
})

test('the playground link comes from the settings, never carries the key, and says when it cannot work', () => {
  const loop = { bindAddress: '127.0.0.1', port: 8100, publicUrl: '' }
  assert.deepEqual(mediaPlaygroundLink(loop, '127.0.0.1'), { url: 'http://127.0.0.1:8100/ui/', remote: false, note: null })
  const remote = mediaPlaygroundLink(loop, 'box.lan')
  assert.equal(remote.url, null)
  assert.match(remote.note, /ssh -L 8100:127\.0\.0\.1:8100/)
  assert.equal(mediaPlaygroundLink({ ...loop, publicUrl: 'https://media.lan' }, 'box.lan').url, 'https://media.lan/ui/')
  const lan = mediaPlaygroundLink({ ...loop, bindAddress: '0.0.0.0' }, 'box.lan')
  assert.equal(lan.url, 'http://box.lan:8100/ui/')
  assert.match(lan.note, /Unverschlüsselt/)
  assert.equal(mediaPlaygroundLink({ ...loop, bindAddress: '10.0.0.5' }, 'box.lan').url, 'http://10.0.0.5:8100/ui/')
  assert.equal(mediaPlaygroundLink({ ...loop, bindAddress: '0.0.0.0' }, '::1').url, 'http://[::1]:8100/ui/')
})

test('profile state reads unsupported, ready, partial and missing apart', () => {
  assert.equal(mediaProfileState({ status: 'unsupported' }).key, 'unsupported')
  assert.equal(mediaProfileState({ status: 'supported', available: true }).key, 'ready')
  const partial = { status: 'supported', available: false, tasks_available: { a: true, b: false } }
  assert.equal(mediaProfileState(partial).key, 'partial')
  assert.equal(mediaProfileState({ status: 'supported', available: false, tasks_available: { a: false } }).key, 'missing')
})

test('warnings name the risky choices and stay quiet for the defaults', () => {
  assert.deepEqual(mediaConfigWarnings(defaults()), [])
  const texts = mediaConfigWarnings({
    ...defaults(),
    bindAddress: '0.0.0.0',
    publicUrl: 'https://media.lan',
    allowDownloads: true,
    modelsReadOnly: false,
    memoryCheck: 'off',
  }).map((w) => w.text)
  assert.equal(texts.length, 4)
  assert.ok(texts.some((t) => /unverschlüsselt/.test(t)))
  assert.ok(texts.some((t) => /HTTPS/.test(t)))
})

/* ---------------------------------- argv ---------------------------------- */

const FILES = { apiKey: '/cfg/media-api/api-key', sessionSecret: '/cfg/media-api/session-secret' }
const SPEC = {
  containerName: 'media-api',
  image: 'docker.io/st3v0rr/amd-strix-halo-toolboxes:media-api',
  hostPort: 8100,
  modelsDir: '/home/u/comfy-models',
  dataDir: '/home/u/media-api-data',
  secretFiles: FILES,
}

test('the media argv carries the hardening of the documented command', () => {
  const argv = buildMediaRunArgv({ ...SPEC, env: mediaContainerEnv(defaults()) })
  for (const flag of ['--userns=keep-id', '--cap-drop=all', '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined']) {
    assert.ok(argv.includes(flag), flag)
  }
  assert.deepEqual(argv.slice(argv.indexOf('--device'), argv.indexOf('--device') + 6), [
    '--device', '/dev/dri', '--device', '/dev/kfd', '--group-add', 'keep-groups',
  ])
  assert.equal(argv[argv.indexOf('-p') + 1], '127.0.0.1:8100:8100')
  assert.ok(argv.includes('/home/u/comfy-models:/models:ro,z'))
  assert.ok(argv.includes('/home/u/media-api-data:/data:z'))
  assert.ok(argv.includes('/cfg/media-api/api-key:/run/secrets/media-api-key:ro,z'))
  assert.ok(argv.includes('MEDIA_API_KEY_FILE=/run/secrets/media-api-key'))
  assert.ok(argv.includes('MEDIA_SESSION_SECRET_FILE=/run/secrets/media-api-session'))
  assert.equal(argv.at(-1), SPEC.image, 'no command: the image starts the service')
  assert.ok(!argv.some((a) => /^MEDIA_API_KEY=|^MEDIA_SESSION_SECRET=|HF_TOKEN=/.test(a)), 'no secret values')
})

test('the mock backend gets neither the GPU nor an unconfined seccomp', () => {
  const argv = buildMediaRunArgv({ ...SPEC, backend: 'mock' })
  assert.ok(!argv.includes('/dev/kfd'))
  assert.ok(!argv.includes('--security-opt=seccomp=unconfined'))
  assert.ok(argv.includes('--cap-drop=all'))
})

test('a writable model mount and a token file only when asked for', () => {
  const argv = buildMediaRunArgv({
    ...SPEC,
    modelsReadOnly: false,
    bindAddress: '10.0.0.5',
    secretFiles: { ...FILES, hfToken: '/cfg/media-api/hf-token' },
  })
  assert.ok(argv.includes('/home/u/comfy-models:/models:z'))
  assert.ok(argv.includes('/cfg/media-api/hf-token:/run/secrets/hf-token.d:ro,z'))
  assert.equal(argv[argv.indexOf('-p') + 1], '10.0.0.5:8100:8100')
})

test('the environment passes only what is set, and no memory check for mock', () => {
  const env = Object.fromEntries(
    mediaContainerEnv({ ...defaults(), limits: { ...defaults().limits, maxSteps: 50 }, corsOrigins: ['https://a.lan'] }),
  )
  assert.equal(env.MEDIA_MAX_STEPS, '50')
  assert.equal(env.MEDIA_MAX_QUEUED_JOBS, undefined)
  assert.equal(env.MEDIA_CORS_ORIGINS, 'https://a.lan')
  assert.equal(env.MEDIA_MEMORY_CHECK, 'strict')
  assert.equal(env.MEDIA_SESSION_TTL_SECONDS, '43200')
  assert.equal(env.MEDIA_ALLOW_DOWNLOADS, '0')
  assert.equal(env.HF_TOKEN_PATH, undefined)
  const mock = Object.fromEntries(mediaContainerEnv({ ...defaults(), backend: 'mock' }))
  assert.equal(mock.MEDIA_MEMORY_CHECK, undefined)
  assert.equal(Object.fromEntries(mediaContainerEnv(defaults(), { hfToken: true })).HF_TOKEN_PATH, '/run/secrets/hf-token.d/token')
})

test('the check runs without network, secrets or a writable tree', () => {
  const argv = buildMediaCheckArgv({ image: 'img', modelsDir: '/m' })
  assert.ok(argv.includes('--network=none') && argv.includes('--rm') && argv.includes('--cap-drop=all'))
  assert.ok(argv.includes('/m:/models:ro,z'))
  assert.ok(!argv.some((a) => a.includes('secrets')))
  assert.deepEqual(argv.slice(-4), ['img', 'media-api-models', 'check', '--json'])
  assert.deepEqual(buildMediaExecCheckArgv('media-api'), ['exec', 'media-api', 'media-api-models', 'check', '--json'])
})

test('the fetch mounts a token file, never passes a token value or name, and names its container per job', () => {
  const name = mediaFetchContainer('0f1e2d3c-4b5a-6978-8a9b-abcdef012345')
  assert.equal(name, 'shx-media-fetch-0f1e2d3c4b5a')
  const argv = buildMediaFetchArgv({
    image: 'img', modelsDir: '/m', model: 'minimax-h3', profile: 'int8', task: 'text-to-video', name,
    tokenFile: '/cfg/media-api/fetch-abc.token',
  })
  assert.equal(argv[argv.indexOf('--name') + 1], name)
  assert.ok(argv.includes(`${MEDIA_FETCH_LABEL}=true`))
  assert.ok(argv.includes('/m:/models:z'))
  assert.ok(argv.includes('/cfg/media-api/fetch-abc.token:/run/secrets/hf-token:ro,z'))
  assert.ok(argv.includes('HF_TOKEN_PATH=/run/secrets/hf-token'))
  assert.ok(!argv.some((a) => a === 'HF_TOKEN' || a.startsWith('HF_TOKEN=')), 'no token by name or value')
  assert.deepEqual(argv.slice(-9), [
    'img', 'media-api-models', 'fetch', 'minimax-h3', '--profile', 'int8', '--task', 'text-to-video', '--json',
  ])
  const bare = buildMediaFetchArgv({ image: 'i', modelsDir: '/m', model: 'x', profile: 'p', name })
  assert.ok(!bare.some((a) => a.includes('hf-token') || a.startsWith('HF_TOKEN')))
})

/* --------------------------------- labels --------------------------------- */

test('the media role and its mounts survive a round trip through the labels', () => {
  const labels = buildMediaLabels({
    image: SPEC.image,
    hostPort: 8100,
    bindAddress: '127.0.0.1',
    modelsDir: SPEC.modelsDir,
    modelsReadOnly: true,
    dataDir: SPEC.dataDir,
    backend: 'real',
    allowDownloads: false,
    specHash: 'abc123',
  })
  assert.equal(labels[LABEL.role], ROLE.media)
  assert.equal(Object.values(labels).some((v) => /secret|key/i.test(v)), false)
  const parsed = parseLabels(labels)
  assert.equal(parsed.role, ROLE.media)
  assert.equal(parsed.hostPort, 8100)
  assert.equal(parsed.mediaModelsReadOnly, true)
  assert.equal(parsed.mediaAllowDownloads, false)
  assert.equal(parsed.mediaDataDir, SPEC.dataDir)
  assert.equal(parsed.bindAddress, '127.0.0.1')
  assert.equal(parsed.specHash, 'abc123')
})

/* --------------------------------- config --------------------------------- */

test('directories that would expose the box are refused', () => {
  const home = os.homedir()
  for (const bad of ['relative/dir', '/tmp/a:b', '/tmp/a,b', home, '/', path.dirname(home), path.join(home, '.ssh', 'x'), '/etc/media']) {
    assert.throws(() => checkMediaDir('Das Datenverzeichnis', bad), { status: 400 }, bad)
  }
  const safe = tmp('shx-normalize-')
  assert.equal(checkMediaDir('Das Datenverzeichnis', path.join(safe, 'x', '..', 'data')), path.join(safe, 'data'))
})

function fakeCtx(overrides = {}) {
  const root = tmp('shx-media-config-')
  const secretsDir = path.join(root, 'secrets')
  return {
    media: { data: { ...defaults(), dataDir: path.join(root, 'media-data'), ...overrides } },
    mediaSecrets: createMediaSecrets(secretsDir),
    config: { data: { hfToken: '' } },
    settings: { comfyModelsDir: path.join(root, 'comfy-models') },
  }
}

test('downloads by the service need a writable tree, and the trees must not nest', () => {
  const ctx = fakeCtx()
  assert.deepEqual(checkMediaConfig(ctx, ctx.media.data), {
    modelsDir: ctx.settings.comfyModelsDir,
    dataDir: ctx.media.data.dataDir,
  })
  assert.throws(() => checkMediaConfig(ctx, { ...ctx.media.data, allowDownloads: true }), /beschreibbaren/)
  assert.throws(
    () => checkMediaConfig(ctx, { ...ctx.media.data, dataDir: path.join(ctx.settings.comfyModelsDir, 'out') }),
    /ineinander/,
  )
})

test('the spec hash tracks every setting that changes the container', () => {
  const ctx = fakeCtx()
  const base = mediaSpec(ctx).specHash
  assert.equal(mediaSpec(ctx).specHash, base, 'stable')
  assert.notEqual(mediaSpec(ctx, { ...ctx.media.data, logLevel: 'debug' }).specHash, base)
  assert.notEqual(mediaSpec(ctx, { ...ctx.media.data, port: 8101 }).specHash, base)
  assert.equal(mediaSpec(ctx, { ...ctx.media.data, autostart: true }).specHash, base, 'autostart is not part of the container')
  // A token only matters to a service that may download.
  ctx.config.data.hfToken = 'hf_secret_token_value'
  assert.equal(mediaSpec(ctx).specHash, base)
  assert.notEqual(mediaSpec(ctx, { ...ctx.media.data, allowDownloads: true, modelsReadOnly: false }).secretFiles.hfToken, null)
})

/* --------------------------------- secrets -------------------------------- */

test('secrets are 0600 files in a 0700 directory, reported by fingerprint only', () => {
  clearSecrets()
  const dir = path.join(tmp('shx-secrets-'), 'media-api')
  const secrets = createMediaSecrets(dir)
  assert.equal(secrets.status().apiKey.configured, false)
  const status = secrets.ensure()
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  for (const file of [secrets.paths().apiKey, secrets.paths().sessionSecret]) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  }
  const key = secrets.apiKey()
  assert.equal(checkMediaApiKey(key), null)
  assert.match(status.apiKey.fingerprint, /^[0-9a-f]{12}$/)
  assert.ok(!JSON.stringify(status).includes(key), 'the status never carries the value')
  // Once read, a value is scrubbed from anything on its way out.
  assert.equal(redact(`key=${key}`), 'key=***')

  const before = status.apiKey.fingerprint
  assert.notEqual(secrets.rotate('apiKey').apiKey.fingerprint, before)
  assert.equal(redact(`old=${key}`), `old=${key}`, 'a replaced key is forgotten by the redactor')
  assert.throws(() => secrets.setApiKey('changeme'), { status: 400 })
  assert.throws(() => secrets.setApiKey(fs.readFileSync(secrets.paths().sessionSecret, 'utf8').trim()), /Sitzungsgeheimnis/)
  secrets.setApiKey('my-own-client-key-0123456789')
  assert.equal(secrets.apiKey(), 'my-own-client-key-0123456789')
  assert.equal(secrets.ensure().apiKey.configured, true, 'an acceptable existing key is kept')
  assert.equal(secrets.apiKey(), 'my-own-client-key-0123456789')
})

test('an existing key the service would refuse is reported, not overwritten', () => {
  const dir = tmp('shx-secrets-')
  fs.writeFileSync(path.join(dir, 'api-key'), 'changeme\n', { mode: 0o600 })
  const secrets = createMediaSecrets(dir)
  assert.throws(() => secrets.ensure(), { status: 424 })
  assert.equal(fs.readFileSync(path.join(dir, 'api-key'), 'utf8'), 'changeme\n')
})

test('the Hugging Face token file exists only while needed', () => {
  const secrets = createMediaSecrets(tmp('shx-secrets-'))
  const file = secrets.syncHfToken('hf_abcdefghijklmnop')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(secrets.syncHfToken(null), null)
  assert.equal(fs.existsSync(file), false)
})

/* -------------------------------- progress -------------------------------- */

test('fetch progress combines the plan, the file events and tqdm', () => {
  const p = new MediaFetchProgress()
  p.line(JSON.stringify({ event: 'plan', files: [{ path: 'a/x.safetensors', bytes: 1000 }, { path: 'b/y.safetensors', bytes: 3000 }], total_bytes: 4000 }))
  p.line(JSON.stringify({ event: 'file', path: 'a/x.safetensors', index: 0, count: 2, bytes: 1000 }))
  p.stderr('x.safetensors:  50%|█████     | 500/1000 [00:01<00:01, 1kB/s]')
  assert.deepEqual(p.snapshot(), { pct: 13, done: 500, total: 4000, files: { done: 0, total: 2 } })
  p.line(JSON.stringify({ event: 'fetched', path: 'a/x.safetensors' }))
  p.line(JSON.stringify({ event: 'file', path: 'b/y.safetensors', index: 1, count: 2, bytes: 3000 }))
  assert.equal(p.snapshot().done, 1000)
  p.line(JSON.stringify({ event: 'fetched', path: 'b/y.safetensors' }))
  p.line(JSON.stringify({ event: 'done', fetched: ['a/x.safetensors', 'b/y.safetensors'] }))
  assert.deepEqual(p.snapshot(), { pct: 100, done: 4000, total: 4000, files: { done: 2, total: 2 } })
  assert.deepEqual(p.fetched, ['a/x.safetensors', 'b/y.safetensors'])
  assert.equal(p.line('not json'), null)
  assert.equal(p.line('{"event": "made-up"}'), null)
})

test('without sizes the bar counts entries', () => {
  const p = new MediaFetchProgress()
  p.line(JSON.stringify({ event: 'plan', files: [{ path: 'a', bytes: null }, { path: 'b', bytes: null }], total_bytes: null }))
  p.line(JSON.stringify({ event: 'fetched', path: 'a' }))
  assert.deepEqual(p.snapshot(), { pct: 50, done: null, total: null, files: { done: 1, total: 2 } })
  p.line(JSON.stringify({ event: 'error', message: 'boom' }))
  assert.equal(p.error, 'boom')
})

test('the rate meter smooths and estimates', () => {
  const meter = rateMeter()
  assert.deepEqual(meter(0, 1000, 0), { rate: null, eta: null })
  assert.deepEqual(meter(100, 1000, 1000), { rate: 100, eta: 9 })
})

/* -------------------------------- inventory ------------------------------- */

const DOC = {
  version: 1,
  models_dir: '/models',
  models: [
    {
      id: 'qwen-image-2512',
      label: 'Qwen-Image-2512',
      provider: 'qwen-image',
      tasks: ['text-to-image'],
      default_profile: 'fp8',
      profiles: [{ id: 'fp8', label: 'FP8', status: 'supported', tasks: ['text-to-image'], estimated_memory_gb: 36, available: false, missing: ['x'] }],
    },
  ],
}

test('the inventory is parsed only in the known shape', () => {
  assert.equal(parseInventory(`warning on stdout\n${JSON.stringify(DOC)}`).models[0].profiles[0].id, 'fp8')
  assert.throws(() => parseInventory('nope'), { code: 'bad_inventory' })
  assert.throws(() => parseInventory(JSON.stringify({ ...DOC, version: 2 })), { code: 'bad_inventory' })
})

test('an image from before --json says so instead of failing obscurely', () => {
  assert.equal(explainCheckFailure(2, '', 'media-api-models: error: unrecognized arguments: --json').status, 424)
  assert.equal(explainCheckFailure(2, '', 'configuration error: MEDIA_API_KEY is not set.').status, 424)
  assert.equal(explainCheckFailure(1, '', 'Traceback …').status, 502)
})

/* ------------------------- network, catalog, comfy ------------------------- */

test('a media port bound to loopback says a firewall rule would not help', () => {
  assert.equal(describeRole({ role: ROLE.media, name: 'm', bindAddress: '127.0.0.1' }).kind, 'media')
  assert.match(describeRole({ role: ROLE.media, name: 'm', bindAddress: '127.0.0.1' }).detail, /bewirkt nichts/)
  assert.match(describeRole({ role: ROLE.media, name: 'm', bindAddress: '0.0.0.0' }).detail, /Klartext/)
})

test('the media image is in the catalog as its own kind', () => {
  const entry = catalog().find((e) => e.tag === 'media-api')
  assert.equal(entry.kind, 'media')
  assert.match(entry.ref, /:media-api$/)
  assert.ok(entry.description)
})

test('the media API folders in the shared tree are measured, not called stray', async () => {
  invalidateComfyModelCache()
  const root = tmp('shx-comfy-')
  for (const [rel, size] of [['diffusers/Qwen-Image-2512/vae/model.safetensors', 300], ['diffusers/Qwen-Image-2512/model_index.json', 20], ['irgendwas/x.bin', 5]]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), Buffer.alloc(size))
  }
  const { folders } = await scanComfyModels(root, { force: true })
  const diffusers = folders.find((f) => f.name === 'diffusers')
  assert.equal(diffusers.owner, 'media')
  assert.equal(diffusers.totalBytes, 320)
  assert.equal(diffusers.fileCount, 2)
  assert.equal(folders.find((f) => f.name === 'irgendwas').owner, undefined)
  assert.ok(MEDIA_MODEL_DIRS.includes('huggingface'))
})

/* -------------------------- symlinks and TOCTOU --------------------------- */

test('a link of anyone but root is refused wherever it sits in the path', () => {
  const root = tmp('shx-links-')
  fs.mkdirSync(path.join(root, 'real', 'deep'), { recursive: true })
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))
  assert.throws(() => checkMediaDir('X', path.join(root, 'link')), /symbolischer Link/)
  assert.throws(() => checkMediaDir('X', path.join(root, 'link', 'deep', 'not-yet')), /symbolischer Link/)
  // Where it leads matters too: a link into ~/.ssh is refused either way.
  fs.symlinkSync(path.join(os.homedir(), '.ssh'), path.join(root, 'ssh'))
  assert.throws(() => checkMediaDir('X', path.join(root, 'ssh')), { status: 400 })
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'))
  assert.throws(() => checkMediaDir('X', path.join(root, 'dangling', 'x')), { status: 400 })
  assert.equal(checkMediaDir('X', path.join(root, 'real', 'deep')), fs.realpathSync(path.join(root, 'real', 'deep')))
})

test('only root-made links in root-only directories are followed, like /home -> /var/home', () => {
  const rootDir = { uid: 0, mode: 0o40755 }
  assert.equal(trustedLink({ uid: 0 }, rootDir), true)
  assert.equal(trustedLink({ uid: 1000 }, rootDir), false)
  assert.equal(trustedLink({ uid: 0 }, { uid: 0, mode: 0o41777 }), false, 'world-writable parent, like /tmp')
  assert.equal(trustedLink({ uid: 0 }, { uid: 1000, mode: 0o40755 }), false)
})

test('ensureMediaDir creates, re-checks and refuses a directory swapped for a link', () => {
  const root = tmp('shx-ensure-')
  const target = path.join(root, 'data')
  assert.equal(ensureMediaDir('X', target, 0o700), fs.realpathSync(target))
  assert.equal(fs.statSync(target).mode & 0o777, 0o700)
  // The swap a TOCTOU would need: the directory replaced by a link after a check.
  fs.rmSync(target, { recursive: true })
  fs.symlinkSync(path.join(os.homedir(), '.config'), target)
  assert.throws(() => ensureMediaDir('X', target, 0o700), { status: 400 })
})

test('fingerprints are keyed with a local pepper: no offline verifier for a weak key', () => {
  const secrets = createMediaSecrets(path.join(tmp('shx-pepper-'), 'media-api'))
  secrets.ensure()
  secrets.setApiKey('weak-but-valid-key-123')
  const { fingerprint } = secrets.status().apiKey
  const plain = createHash('sha256').update('weak-but-valid-key-123').digest('hex').slice(0, 12)
  assert.notEqual(fingerprint, plain)
  assert.equal(secrets.status().apiKey.fingerprint, fingerprint, 'stable on this box')
  assert.equal(fs.statSync(path.join(secrets.dir, 'fingerprint-pepper')).mode & 0o777, 0o600)
})

test('a changed or removed global token reaches the mounted directory atomically', () => {
  const secrets = createMediaSecrets(tmp('shx-hf-'))
  assert.equal(secrets.refreshHfToken('hf_new_token_value_1'), false, 'no file, nothing mounted, nothing to do')
  const file = secrets.syncHfToken('hf_first_token_value')
  const inode = fs.statSync(file).ino
  assert.equal(secrets.hfTokenState(), 'active')
  assert.equal(secrets.refreshHfToken('hf_second_token_value'), true)
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'hf_second_token_value')
  assert.notEqual(fs.statSync(file).ino, inode, 'rename replaces the inode inside the mounted directory')
  secrets.refreshHfToken(null)
  assert.equal(fs.readFileSync(file, 'utf8'), '')
  assert.equal(secrets.hfTokenState(), 'revoked')
  secrets.syncHfToken(null)
  assert.equal(secrets.hfTokenState(), 'none')
})

test('partial token writes and fsync failures leave the live token intact and are retryable', () => {
  const dir = tmp('shx-hf-atomic-')
  const secrets = createMediaSecrets(dir)
  const file = secrets.syncHfToken('hf_original_token_value')

  const partial = Object.create(fs)
  partial.writeFileSync = (fd, value) => {
    fs.writeSync(fd, String(value).slice(0, 4))
    throw Object.assign(new Error('partial write'), { code: 'EIO' })
  }
  assert.throws(() => createMediaSecrets(dir, partial).refreshHfToken('hf_replacement_value'), /partial write/)
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'hf_original_token_value')

  const noSync = Object.create(fs)
  noSync.fsyncSync = () => {
    throw Object.assign(new Error('fsync failed'), { code: 'EIO' })
  }
  assert.throws(() => createMediaSecrets(dir, noSync).refreshHfToken('hf_replacement_value'), /fsync failed/)
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'hf_original_token_value')

  let syncs = 0
  const uncertain = Object.create(fs)
  uncertain.fsyncSync = (fd) => {
    syncs += 1
    if (syncs === 2) throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' })
    fs.fsyncSync(fd)
  }
  const uncertainSecrets = createMediaSecrets(dir, uncertain)
  assert.throws(() => uncertainSecrets.refreshHfToken('hf_complete_new_value'), /directory fsync failed/)
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'hf_complete_new_value', 'rename leaves a complete new state')

  assert.equal(secrets.refreshHfToken('hf_replacement_value'), true)
  assert.equal(fs.readFileSync(file, 'utf8').trim(), 'hf_replacement_value')
})

test('JsonStore rejects a post-rename directory fsync failure and retries with exact durable mode', async () => {
  const dir = tmp('shx-json-durable-')
  const file = path.join(dir, 'config.json')
  let failDirectorySync = true
  const io = {
    mkdir: fsp.mkdir.bind(fsp),
    rename: fsp.rename.bind(fsp),
    rm: fsp.rm.bind(fsp),
    async open(target, flags, mode) {
      const handle = await fsp.open(target, flags, mode)
      if (target !== dir) return handle
      return {
        close: () => handle.close(),
        async sync() {
          if (failDirectorySync) {
            failDirectorySync = false
            throw Object.assign(new Error('injected config directory fsync failure'), { code: 'EIO' })
          }
          return handle.sync()
        },
      }
    },
  }
  const store = new JsonStore({ file, schema: mediaConfigSchema, mode: 0o640, debounceMs: 0, io })
  await assert.rejects(
    store.update((config) => ({ ...config, port: 19001 })),
    /injected config directory fsync failure/,
  )
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 19001, 'readability is not reclassified as commit')

  await store.flush()
  assert.equal(fs.statSync(file).mode & 0o777, 0o640)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).port, 19001)
})

test('fetch token copies are 0600, per job, and swept', () => {
  const secrets = createMediaSecrets(tmp('shx-fetchtok-'))
  const a = secrets.writeFetchToken('job-a/../x', 'hf_token_value_abcdef')
  assert.equal(path.dirname(a), secrets.dir, 'the job id cannot steer the path')
  assert.equal(fs.statSync(a).mode & 0o777, 0o600)
  const b = secrets.writeFetchToken('jobb', 'hf_token_value_abcdef')
  secrets.removeFetchToken('jobb')
  assert.equal(fs.existsSync(b), false)
  secrets.removeFetchTokens()
  assert.equal(fs.existsSync(a), false)
})

test('a bind source replaced after the check is refused before start', () => {
  const dir = path.join(tmp('shx-pin-'), 'models')
  const pin = { ...pinMediaDir('X', dir, 0o755), destination: '/models' }
  const mounts = [{ Source: pin.path, Destination: '/models' }]
  verifyMediaMounts(mounts, [pin])
  assert.throws(() => verifyMediaMounts([{ Source: '/elsewhere', Destination: '/models' }], [pin]), { status: 409 })
  fs.renameSync(dir, `${dir}.old`)
  fs.mkdirSync(dir)
  assert.throws(() => verifyMediaMounts(mounts, [pin]), /ersetzt/)
})

test('every group/world-writable path component is refused, including sticky and own-group directories', () => {
  const shared = path.join(tmp('shx-perm-'), 'shared')
  fs.mkdirSync(shared)
  fs.chmodSync(shared, 0o777)
  assert.throws(() => checkMediaDir('X', path.join(shared, 'data')), /andere schreiben/)
  fs.chmodSync(shared, 0o1777)
  assert.throws(() => checkMediaDir('X', path.join(shared, 'data')), /andere schreiben/)
  fs.chmodSync(shared, 0o775)
  assert.throws(() => checkMediaDir('X', path.join(shared, 'data')), /andere schreiben/)
  fs.chmodSync(shared, 0o755)
  assert.equal(checkMediaDir('X', path.join(shared, 'data')), path.join(fs.realpathSync(shared), 'data'))
})
