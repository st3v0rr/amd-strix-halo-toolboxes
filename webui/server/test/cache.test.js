import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { assertSafeMountpoint } from '../src/podman/cache.js'
import { readDisk } from '../src/system/host.js'

const VOLUME = 'shx-rpc-cache-rpc-worker'
const REAL = `/home/stefan/.local/share/containers/storage/volumes/${VOLUME}/_data`

test('a real podman volume mountpoint is accepted', () => {
  assert.doesNotThrow(() => assertSafeMountpoint(REAL, VOLUME))
})

test('the guard refuses paths that would delete something else entirely', () => {
  // What this is really protecting against: podman answering with something
  // unexpected, or an empty format result collapsing into a short path. The
  // next statement after this check is a recursive delete.
  for (const bad of ['/', '/home', '/home/stefan', '', '  ']) {
    assert.throws(() => assertSafeMountpoint(bad, VOLUME), /Unerwarteter Volume-Pfad/, bad)
  }
})

test('a deep path that is not this volume is refused', () => {
  const other = '/home/stefan/.local/share/containers/storage/volumes/some-other-volume/_data'
  assert.throws(() => assertSafeMountpoint(other, VOLUME), /Unerwarteter Volume-Pfad/)
})

test('a relative path is refused even when it names the volume', () => {
  assert.throws(() => assertSafeMountpoint(`a/b/c/${VOLUME}/_data`, VOLUME), /Unerwarteter/)
})

test('readDisk reports a plausible filesystem for an existing directory', async () => {
  const disk = await readDisk(os.tmpdir())
  assert.ok(disk, 'expected a reading for the temp directory')
  assert.equal(disk.path, os.tmpdir())
  assert.ok(disk.totalBytes > 0)
  assert.ok(disk.usedBytes >= 0 && disk.usedBytes <= disk.totalBytes)
  // bavail excludes root's reserve, so free space never exceeds what is unused.
  assert.ok(disk.availableBytes <= disk.totalBytes - disk.usedBytes + 1)
})

test('readDisk degrades to null rather than throwing', async () => {
  assert.equal(await readDisk(null), null)
  assert.equal(await readDisk(path.join(os.tmpdir(), 'shx-does-not-exist-9d3f')), null)
})
