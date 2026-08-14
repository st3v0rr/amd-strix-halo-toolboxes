import fsp from 'node:fs/promises'
import path from 'node:path'

import { ROLE } from '../../../shared/constants.js'
import { badRequest, conflict } from '../lib/errors.js'
import { run } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { rpcCacheVolume } from './argv.js'

/**
 * The tensor cache an RPC worker keeps on disk.
 *
 * `ggml-rpc-server -c` writes every tensor it receives to
 * /root/.cache/llama.cpp/rpc/, which is what makes the second start of a model
 * fast instead of another full transfer over the network. Nothing prunes it,
 * though: every model a worker has ever served stays there, and on a 100+ GB
 * model that adds up quickly. Hence a way to look at it and empty it.
 */

/** Mountpoint of a named volume on the host, or null if podman has no such volume. */
async function volumeMountpoint(volume) {
  const { stdout, code } = await run(
    'podman',
    ['volume', 'inspect', volume, '--format', '{{.Mountpoint}}'],
    { allowFailure: true },
  )
  if (code !== 0) return null
  return stdout.trim() || null
}

/**
 * Refuse to touch anything that is not plainly a podman volume directory.
 *
 * The path comes straight from `podman volume inspect` for a volume name we
 * derived ourselves, so this is a backstop rather than the real control. But
 * what follows is a recursive delete, and a backstop costs nothing: a real
 * mountpoint sits several levels deep and carries the volume's name as one of
 * its segments, which "/" and "/home" can never both satisfy.
 */
export function assertSafeMountpoint(mountpoint, volume) {
  const segments = mountpoint.split(path.sep).filter(Boolean)
  if (!path.isAbsolute(mountpoint) || segments.length < 4 || !segments.includes(volume)) {
    throw badRequest(`Unerwarteter Volume-Pfad, wird nicht angefasst: ${mountpoint}`)
  }
}

/**
 * Total bytes and file count under `dir`.
 *
 * Hand-rolled recursion rather than `readdir({recursive: true})`, whose Dirent
 * carries the parent path under a property that was renamed across Node 20
 * minors. Symlinks are counted as neither file nor directory, so this cannot
 * be walked out of the volume.
 */
async function measure(dir) {
  let bytes = 0
  let files = 0
  const pending = [dir]

  while (pending.length) {
    const current = pending.pop()
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue // vanished or unreadable — not worth failing the whole report
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(full)
      } else if (entry.isFile()) {
        try {
          const stats = await fsp.stat(full)
          bytes += stats.size
          files += 1
        } catch {
          // Gone between readdir and stat; the worker writes here while it runs.
        }
      }
    }
  }

  return { bytes, files }
}

function assertRpc(server) {
  if (server.role !== ROLE.rpc) {
    throw badRequest(`'${server.name}' ist kein RPC-Worker und hat keinen Tensor-Cache.`)
  }
}

/**
 * What the worker currently has cached.
 *
 * @param {{name: string, role: string}} server
 */
export async function rpcCacheInfo(server) {
  assertRpc(server)
  const volume = rpcCacheVolume(server.name)
  const mountpoint = await volumeMountpoint(volume)

  // No volume yet means the worker has never run — an empty cache, not an error.
  if (!mountpoint) return { volume, mountpoint: null, exists: false, bytes: 0, files: 0 }

  const { bytes, files } = await measure(mountpoint)
  return { volume, mountpoint, exists: true, bytes, files }
}

/**
 * Empty the cache, keeping the volume itself.
 *
 * Emptying rather than `podman volume rm --force`, which removes the
 * containers using the volume as well — that would delete the worker the user
 * was trying to clean up after. Requires the container to be stopped, because
 * a running worker reads and writes these files mid-transfer.
 *
 * @param {{name: string, role: string, running: boolean}} server
 */
export async function clearRpcCache(server) {
  assertRpc(server)
  if (server.running) {
    throw conflict(
      `'${server.name}' läuft. Stoppe den Worker zuerst — bei laufender Übertragung würde das Leeren den Cache unter dem Server wegziehen.`,
    )
  }

  const volume = rpcCacheVolume(server.name)
  const mountpoint = await volumeMountpoint(volume)
  if (!mountpoint) return { volume, cleared: false, freedBytes: 0 }

  assertSafeMountpoint(mountpoint, volume)
  const before = await measure(mountpoint)

  // Remove the contents, not the directory: podman created it with the
  // ownership and SELinux label the container expects.
  const entries = await fsp.readdir(mountpoint)
  for (const entry of entries) {
    await fsp.rm(path.join(mountpoint, entry), { recursive: true, force: true })
  }

  log.info(`RPC-Cache '${volume}' geleert (${before.files} Dateien).`)
  return { volume, cleared: true, freedBytes: before.bytes, freedFiles: before.files }
}
