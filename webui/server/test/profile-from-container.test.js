import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apiKeyFromCommand, profileFromContainer } from '../src/podman/servers.js'
import { SERVER_DEFAULTS } from '../../shared/constants.js'

/* --------------------------- apiKeyFromCommand --------------------------- */

test('the api key is read back out of the container argv', () => {
  // The only place it still exists: labels deliberately do not carry it.
  const argv = ['llama-server', '-m', '/workspace/models/a.gguf', '--api-key', 'sekret', '-fa', 'on']
  assert.equal(apiKeyFromCommand(argv), 'sekret')
})

test('a container started without a key yields an empty one', () => {
  assert.equal(apiKeyFromCommand(['llama-server', '-m', '/x.gguf']), '')
  assert.equal(apiKeyFromCommand(null), '')
  assert.equal(apiKeyFromCommand(undefined), '')
  assert.equal(apiKeyFromCommand('--api-key k'), '')
})

test('a trailing --api-key without a value does not read past the end', () => {
  assert.equal(apiKeyFromCommand(['llama-server', '--api-key']), '')
})

/* -------------------------- profileFromContainer ------------------------- */

const SERVER = {
  name: 'flash-next',
  role: 'server',
  image: 'docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-10.0',
  modelPath: 'Qwen3.8-Flash-Next-GGUF/UD-Q4_K_XL/m.gguf',
  mmprojPath: 'Qwen3.8-Flash-Next-GGUF/mmproj-F16.gguf',
  specType: 'draft-mtp',
  specDraftNMax: 3,
  hostPort: 11555,
  ctxSize: 90000,
  gpuLayers: 999,
  threads: 16,
  extraArgs: '-fa on --load-mode none',
  rpcPeers: ['192.168.100.11:50052'],
  command: ['llama-server', '-m', '/workspace/models/x.gguf', '--api-key', 'abcdefgh'],
}

test('every setting a container carries reaches the profile', () => {
  assert.deepEqual(profileFromContainer(SERVER), {
    name: 'flash-next',
    image: 'docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-10.0',
    modelPath: 'Qwen3.8-Flash-Next-GGUF/UD-Q4_K_XL/m.gguf',
    mmprojPath: 'Qwen3.8-Flash-Next-GGUF/mmproj-F16.gguf',
    specType: 'draft-mtp',
    specDraftNMax: 3,
    port: 11555,
    ctxSize: 90000,
    gpuLayers: 999,
    threads: 16,
    apiKey: 'abcdefgh',
    extraArgs: '-fa on --load-mode none',
    rpcPeers: ['192.168.100.11:50052'],
    autostart: false,
  })
})

test('autostart is never inherited', () => {
  // A container running right now says nothing about whether the user wants it
  // back after a reboot — that stays an explicit decision in the dialog.
  assert.equal(profileFromContainer({ ...SERVER, autostart: true }).autostart, false)
})

test('a container predating a label falls back to the defaults a new profile has', () => {
  const bare = { name: 'alt', role: 'server', command: [] }
  const profile = profileFromContainer(bare)
  assert.equal(profile.ctxSize, SERVER_DEFAULTS.ctxSize)
  assert.equal(profile.gpuLayers, SERVER_DEFAULTS.gpuLayers)
  assert.equal(profile.threads, SERVER_DEFAULTS.threads)
  assert.equal(profile.modelPath, '')
  assert.equal(profile.mmprojPath, '')
  assert.equal(profile.specType, '')
  assert.equal(profile.specDraftNMax, null)
  assert.equal(profile.extraArgs, '')
  assert.deepEqual(profile.rpcPeers, [])
  // An empty key means the profiles endpoint generates one, rather than the
  // profile being saved with a key of ''.
  assert.equal(profile.apiKey, '')
})
