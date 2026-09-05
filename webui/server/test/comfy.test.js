import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { buildComfyRunArgv } from '../src/podman/argv.js'
import { buildComfyLabels, parseLabels } from '../src/podman/labels.js'
import { COMFY_CATALOG, findComfyDownload } from '../../shared/comfycatalog.js'
import { COMFY_MODEL_DIRS, LABEL, ROLE } from '../../shared/constants.js'
import { invalidateComfyModelCache, scanComfyModels } from '../src/models/comfyscan.js'

/* ------------------------------ buildComfyRunArgv ------------------------------ */

const SPEC = {
  containerName: 'comfyui',
  image: 'docker.io/st3v0rr/amd-strix-halo-toolboxes:comfyui',
  hostPort: 8000,
  modelsDir: '/home/stefan/comfy-models',
  outputDir: '/home/stefan/comfy-outputs',
}

test('the ComfyUI argv publishes 8000 and mounts both directories', () => {
  const argv = buildComfyRunArgv(SPEC)
  assert.deepEqual(argv, [
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--device',
    '/dev/dri',
    '--device',
    '/dev/kfd',
    '--group-add',
    'video',
    '--group-add',
    'render',
    '--security-opt',
    'seccomp=unconfined',
    '-p',
    '8000:8000',
    '--name',
    'comfyui',
    '-v',
    '/home/stefan/comfy-models:/root/comfy-models:z',
    '-v',
    '/home/stefan/comfy-outputs:/root/comfy-outputs:z',
    'docker.io/st3v0rr/amd-strix-halo-toolboxes:comfyui',
  ])
})

test('no command is appended — the image starts ComfyUI itself', () => {
  // Unlike the llama images, whose CMD is overridden to pass flags, the ComfyUI
  // image already carries --listen 0.0.0.0 and the gfx1151 flags. Appending
  // anything here would silently replace that.
  const argv = buildComfyRunArgv(SPEC)
  assert.equal(argv[argv.length - 1], SPEC.image)
})

test('a different host port still maps onto 8000 inside', () => {
  const argv = buildComfyRunArgv({ ...SPEC, hostPort: 8100 })
  assert.equal(argv[argv.indexOf('-p') + 1], '8100:8000')
})

test('labels are emitted between --name and the volumes', () => {
  const argv = buildComfyRunArgv({ ...SPEC, labels: { 'shx.managed': 'true' } })
  const at = argv.indexOf('--label')
  assert.equal(argv[at + 1], 'shx.managed=true')
  assert.ok(argv.indexOf('--name') < at)
  assert.ok(at < argv.indexOf('-v'))
})

/* --------------------------------- labels --------------------------------- */

test('a ComfyUI container carries only what it has', () => {
  const labels = buildComfyLabels({
    image: SPEC.image,
    hostPort: 8000,
    modelsDir: SPEC.modelsDir,
    outputDir: SPEC.outputDir,
  })
  assert.equal(labels[LABEL.role], ROLE.comfy)
  assert.equal(labels[LABEL.comfyModelsDir], SPEC.modelsDir)
  // No model, context, threads or extra args — a ComfyUI container has none.
  assert.equal(labels[LABEL.model], undefined)
  assert.equal(labels[LABEL.ctx], undefined)
})

test('the comfy role survives a round trip through the labels', () => {
  const parsed = parseLabels(
    buildComfyLabels({
      image: SPEC.image,
      hostPort: 8000,
      modelsDir: SPEC.modelsDir,
      outputDir: SPEC.outputDir,
    }),
  )
  assert.equal(parsed.role, ROLE.comfy)
  assert.equal(parsed.comfyModelsDir, SPEC.modelsDir)
  assert.equal(parsed.comfyOutputDir, SPEC.outputDir)
  assert.equal(parsed.hostPort, 8000)
})

test('an unknown role still reads as a llama server', () => {
  // Containers from before the role label existed must not fall out of the list.
  assert.equal(parseLabels({}).role, ROLE.server)
  assert.equal(parseLabels({ [LABEL.role]: 'nonsense' }).role, ROLE.server)
})

/* --------------------------------- catalog -------------------------------- */

test('every catalog entry has a unique id and real arguments', () => {
  const ids = new Set()
  for (const family of COMFY_CATALOG) {
    for (const d of family.downloads) {
      assert.ok(!ids.has(d.id), `duplicate id ${d.id}`)
      ids.add(d.id)
      assert.match(d.script, /^get_[a-z0-9_]+\.sh$/)
      assert.ok(d.args.length > 0, `${d.id} has no arguments`)
      // These end up on a command line inside the container, so nothing in the
      // table may carry shell syntax.
      for (const arg of d.args) assert.match(arg, /^[A-Za-z0-9._-]+$/)
    }
  }
  assert.ok(ids.size > 20)
})

test('a download is looked up by id, never taken from the caller', () => {
  const found = findComfyDownload('wan22-t2v-fp16')
  assert.equal(found.script, 'get_wan22.sh')
  assert.deepEqual(found.args, ['14b-t2v', 'fp16'])
  assert.equal(found.family, 'Wan 2.2')
  assert.equal(findComfyDownload('../../etc/passwd'), null)
  assert.equal(findComfyDownload(''), null)
})

/* -------------------------------- comfyscan ------------------------------- */

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shx-comfy-'))
}

function write(root, rel, bytes = 32) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, Buffer.alloc(bytes))
}

test('every known folder is reported, empty ones included', async () => {
  invalidateComfyModelCache()
  const root = tmpRoot()
  write(root, 'checkpoints/model.safetensors', 500)
  write(root, 'loras/a.safetensors', 100)
  write(root, 'loras/b.safetensors', 200)

  const { folders, totalBytes } = await scanComfyModels(root, { force: true })

  assert.equal(folders.length, COMFY_MODEL_DIRS.length)
  const loras = folders.find((f) => f.name === 'loras')
  assert.equal(loras.files.length, 2)
  assert.equal(loras.totalBytes, 300)
  // An empty folder is a normal state worth showing, not something to hide.
  assert.equal(folders.find((f) => f.name === 'vae').files.length, 0)
  assert.equal(totalBytes, 800)
})

test('a folder ComfyUI does not read is reported as unknown', async () => {
  invalidateComfyModelCache()
  const root = tmpRoot()
  write(root, 'irgendwas/x.safetensors', 10)

  const { folders } = await scanComfyModels(root, { force: true })
  const stray = folders.find((f) => f.name === 'irgendwas')
  assert.equal(stray.known, false)
  assert.equal(stray.files.length, 1)
})

test('a models directory that does not exist yet is not an error', async () => {
  invalidateComfyModelCache()
  const { folders, unreadable, totalBytes } = await scanComfyModels(
    path.join(tmpRoot(), 'noch-nicht-da'),
    { force: true },
  )
  // It appears when the first container starts or the first download lands.
  assert.equal(unreadable, null)
  assert.equal(totalBytes, 0)
  assert.equal(folders.length, COMFY_MODEL_DIRS.length)
})

test('the scan does not recurse — ComfyUI does not either', async () => {
  invalidateComfyModelCache()
  const root = tmpRoot()
  write(root, 'loras/tief/versteckt.safetensors', 10)
  const { folders } = await scanComfyModels(root, { force: true })
  assert.equal(folders.find((f) => f.name === 'loras').files.length, 0)
})
