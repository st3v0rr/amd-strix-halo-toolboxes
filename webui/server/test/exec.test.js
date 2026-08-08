import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

/**
 * The binary table and the search path are read at call time, so each case
 * rearranges the environment and re-imports the module with a cache-busting
 * query to get a fresh resolution cache.
 */
async function freshExec(env) {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  const mod = await import(`../src/lib/exec.js?case=${Math.random().toString(36).slice(2)}`)
  return { mod, restore: () => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  } }
}

function fakeTool(dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, '#!/bin/sh\necho ok\n', { mode: 0o755 })
  return file
}

test('finds a tool in ~/.local/bin even when PATH omits it', async () => {
  // This is the pipx case: `pipx install "huggingface_hub[cli]"` drops hf in
  // ~/.local/bin, which systemd's minimal PATH does not contain.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-home-'))
  const expected = fakeTool(path.join(home, '.local', 'bin'), 'hf')

  const { mod, restore } = await freshExec({
    HOME: home,
    PATH: '/usr/bin:/bin',
    SHX_HF_BIN: '',
  })
  try {
    assert.equal(mod.binaryPath('hf'), expected)
  } finally {
    restore()
  }
})

test('an explicit SHX_*_BIN override wins over the search', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-home-'))
  fakeTool(path.join(home, '.local', 'bin'), 'hf')
  const pinned = fakeTool(path.join(home, 'pinned'), 'hf')

  const { mod, restore } = await freshExec({ HOME: home, PATH: '/usr/bin', SHX_HF_BIN: pinned })
  try {
    assert.equal(mod.binaryPath('hf'), pinned)
  } finally {
    restore()
  }
})

test('PATH takes precedence over the extra directories', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-home-'))
  fakeTool(path.join(home, '.local', 'bin'), 'hf')
  const onPath = fakeTool(path.join(home, 'first'), 'hf')

  const { mod, restore } = await freshExec({
    HOME: home,
    PATH: path.join(home, 'first'),
    SHX_HF_BIN: '',
  })
  try {
    assert.equal(mod.binaryPath('hf'), onPath)
  } finally {
    restore()
  }
})

test('an unfound tool falls back to the bare name', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-home-'))
  const { mod, restore } = await freshExec({
    HOME: home,
    PATH: path.join(home, 'empty'),
    SHX_HF_BIN: '',
  })
  try {
    // spawn then produces a plain ENOENT, which `which()` turns into
    // {available: false} — no invented error here.
    assert.equal(mod.binaryPath('hf'), 'hf')
  } finally {
    restore()
  }
})

test('a non-executable file is not accepted as the tool', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-home-'))
  const dir = path.join(home, '.local', 'bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'hf'), 'not executable', { mode: 0o644 })

  const { mod, restore } = await freshExec({ HOME: home, PATH: '/nonexistent', SHX_HF_BIN: '' })
  try {
    assert.equal(mod.binaryPath('hf'), 'hf')
  } finally {
    restore()
  }
})

test('a relative override resolves against webui/, not the working directory', async () => {
  const { mod, restore } = await freshExec({ SHX_PODMAN_BIN: 'dev/bin/podman' })
  try {
    const resolved = mod.binaryPath('podman')
    assert.ok(path.isAbsolute(resolved))
    assert.ok(resolved.endsWith(path.join('webui', 'dev', 'bin', 'podman')))
  } finally {
    restore()
  }
})

test('which() reports a real tool as available', async () => {
  const { mod, restore } = await freshExec({})
  try {
    const result = await mod.which('git', ['--version'])
    assert.equal(result.available, true)
    assert.match(result.version, /git/i)
  } finally {
    restore()
  }
})
