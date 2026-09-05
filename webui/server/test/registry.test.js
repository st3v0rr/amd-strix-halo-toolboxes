import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseRef, stampToIso } from '../src/images/registry.js'
import { catalog, isKnownRef, knownTags } from '../src/images/catalog.js'

test('parses a docker.io reference into repository and tag', () => {
  assert.deepEqual(parseRef('docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.14'), {
    repository: 'st3v0rr/amd-strix-halo-toolboxes',
    tag: 'rocm-7.14',
  })
})

test('a reference without a tag defaults to latest', () => {
  assert.deepEqual(parseRef('docker.io/user/repo'), { repository: 'user/repo', tag: 'latest' })
})

test('a port in the registry host is not mistaken for a tag', () => {
  assert.deepEqual(parseRef('registry.local:5000/user/repo'), {
    repository: 'registry.local:5000/user/repo',
    tag: 'latest',
  })
  assert.deepEqual(parseRef('registry.local:5000/user/repo:v2'), {
    repository: 'registry.local:5000/user/repo',
    tag: 'v2',
  })
})

test('converts the CI build stamp to ISO 8601', () => {
  // CI pushes <backend>_<YYYYmmddTHHMMSS> next to the moving channel tag.
  assert.equal(stampToIso('20260801T120000'), '2026-08-01T12:00:00Z')
  assert.equal(stampToIso('nonsense'), null)
})

/* -------------------------------- catalog -------------------------------- */

test('the catalog is derived from the Dockerfile directories', () => {
  const tags = knownTags()
  const names = tags.map((t) => t.tag)
  // The llama-server backends this repository builds …
  for (const expected of ['vulkan-radv', 'rocm-7.14', 'rocm-10.0']) {
    assert.ok(names.includes(expected), `expected tag ${expected} in ${names.join(', ')}`)
    assert.equal(tags.find((t) => t.tag === expected).kind, 'llama')
  }
  // … and ComfyUI, which lives in its own directory. Without it the images
  // page cannot pull, re-pull or remove that image at all.
  assert.ok(names.includes('comfyui'))
  assert.equal(tags.find((t) => t.tag === 'comfyui').kind, 'comfy')
})

test('ComfyUI is not offered as a llama-server backend', () => {
  // Both kinds share a DockerHub repository but nothing else. The start dialog
  // for a llama server must never list the ComfyUI image.
  const llama = catalog().filter((e) => e.kind === 'llama').map((e) => e.tag)
  assert.equal(llama.includes('comfyui'), false)
})

test('every catalog entry carries a full image reference', () => {
  for (const entry of catalog()) {
    assert.match(entry.ref, /^docker\.io\/st3v0rr\/amd-strix-halo-toolboxes:/)
    assert.ok(entry.ref.endsWith(`:${entry.tag}`))
  }
})

test('only catalog references count as known', () => {
  assert.equal(isKnownRef('docker.io/st3v0rr/amd-strix-halo-toolboxes:vulkan-radv'), true)
  assert.equal(isKnownRef('docker.io/evil/thing:latest'), false)
  assert.equal(isKnownRef('docker.io/st3v0rr/amd-strix-halo-toolboxes:does-not-exist'), false)
})
