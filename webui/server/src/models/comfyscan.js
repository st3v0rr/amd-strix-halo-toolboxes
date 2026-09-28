import fsp from 'node:fs/promises'
import path from 'node:path'

import { COMFY_MODEL_DIRS, MEDIA_MODEL_DIRS } from '../../../shared/constants.js'

const CACHE_MS = 30_000

let cache = { at: 0, dir: null, value: null }

/**
 * What ComfyUI's model tree holds, grouped by the folder that gives each file
 * its meaning.
 *
 * Deliberately not scanModels(): that one is built around GGUF and shard sets,
 * neither of which applies here. ComfyUI's files are `.safetensors` (with the
 * occasional `.gguf` for the quantised diffusion models), they never come in
 * numbered parts, and the folder a file sits in is what decides whether it is a
 * checkpoint, a LoRA or a VAE — so the folder is the grouping, not the name.
 *
 * The known folders are always reported, empty ones included: an empty
 * `loras/` is a normal state worth showing, not something to hide.
 */
export async function scanComfyModels(modelsDir, { force = false } = {}) {
  if (!force && cache.value && cache.dir === modelsDir && Date.now() - cache.at < CACHE_MS) {
    return cache.value
  }

  const root = path.resolve(modelsDir)
  let unreadable = null
  try {
    await fsp.access(root)
  } catch (err) {
    // Not an error worth failing on: the directory appears when the first
    // ComfyUI container starts, or when the first download lands.
    unreadable = err.code === 'ENOENT' ? null : err.message
  }

  const folders = []
  for (const name of COMFY_MODEL_DIRS) {
    folders.push(await scanFolder(root, name))
  }

  // Anything the user dropped somewhere ComfyUI does not look for. Worth
  // showing, because such a file takes space and will never be found.
  const extra = await strayFolders(root)
  for (const name of extra) {
    // The media API reads this same tree and keeps its diffusers folders and
    // Hugging Face cache beside ComfyUI's. Those are not strays — they are
    // nested, so they are measured whole rather than listed file by file.
    if (MEDIA_MODEL_DIRS.includes(name)) {
      folders.push({ ...(await measureFolder(root, name)), known: false, owner: 'media' })
      continue
    }
    folders.push({ ...(await scanFolder(root, name)), known: false })
  }

  const value = {
    modelsDir: root,
    folders,
    totalBytes: folders.reduce((sum, f) => sum + f.totalBytes, 0),
    unreadable,
  }
  cache = { at: Date.now(), dir: modelsDir, value }
  return value
}

export function invalidateComfyModelCache() {
  cache = { at: 0, dir: null, value: null }
}

/** One folder's files, flat: ComfyUI does not recurse into these either. */
async function scanFolder(root, name) {
  const abs = path.join(root, name)
  const files = []
  try {
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      try {
        const stat = await fsp.stat(path.join(abs, entry.name))
        files.push({
          rel: `${name}/${entry.name}`,
          file: entry.name,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        })
      } catch {
        /* vanished mid-scan */
      }
    }
  } catch {
    /* folder does not exist yet — reported as empty, which it effectively is */
  }

  files.sort((a, b) => a.file.localeCompare(b.file))
  return {
    name,
    known: true,
    files,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
  }
}

/** Size and file count of a whole subtree, without following symlinks. */
async function measureFolder(root, name) {
  let totalBytes = 0
  let fileCount = 0
  const pending = [{ dir: path.join(root, name), depth: 0 }]
  while (pending.length) {
    const { dir, depth } = pending.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 12) pending.push({ dir: abs, depth: depth + 1 })
      else if (entry.isFile()) {
        try {
          totalBytes += (await fsp.stat(abs)).size
          fileCount += 1
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  }
  return { name, known: true, files: [], fileCount, totalBytes }
}

/** Directories in the tree that ComfyUI has no configured path for. */
async function strayFolders(root) {
  const known = new Set(COMFY_MODEL_DIRS)
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !known.has(e.name) && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** Free space on the filesystem holding the ComfyUI models. */
export async function comfyDiskUsage(modelsDir) {
  try {
    const stats = await fsp.statfs(modelsDir)
    return {
      totalBytes: stats.blocks * stats.bsize,
      freeBytes: stats.bavail * stats.bsize,
    }
  } catch {
    return { totalBytes: null, freeBytes: null }
  }
}
