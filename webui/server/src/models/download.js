import fsp from 'node:fs/promises'
import path from 'node:path'

import { AppError, badRequest, failedDependency } from '../lib/errors.js'
import { stream, which } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { listGgufFiles } from './hfapi.js'
import { safeResolve } from './paths.js'
import { diskUsage, invalidateModelCache } from './scan.js'

const POLL_MS = 1000
/** Smoothing factor for the download rate; ~10 s of history at 1 Hz. */
const EWMA_ALPHA = 0.2

/**
 * Turn the user's file selection into `--include` patterns.
 *
 * A directory collapses to a glob only when *every* GGUF in it was selected.
 * Otherwise the patterns stay explicit, however many there are.
 *
 * The earlier version globbed purely on count, which quietly over-fetched:
 * these repos keep two dozen quants flat in the root, so selecting 21 of them
 * produced `*.gguf` and downloaded all of them — tens of gigabytes nobody
 * asked for.
 *
 * @param {string[]} paths selected file paths
 * @param {string[]} [allPaths] every GGUF in the repo, for the "whole folder" test
 */
export function buildIncludes(paths, allPaths = null) {
  const selected = [...paths]
  if (!allPaths || allPaths.length === 0) return selected

  const byDir = new Map()
  for (const p of allPaths) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (!byDir.has(dir)) byDir.set(dir, new Set())
    byDir.get(dir).add(p)
  }

  const selectedSet = new Set(selected)
  const includes = []
  const covered = new Set()

  for (const [dir, all] of byDir) {
    // The repository root is never globbed: `*.gguf` there would also catch
    // every other quant sitting next to the selected one.
    if (!dir) continue
    const everySelected = [...all].every((p) => selectedSet.has(p))
    if (everySelected && all.size > 1) {
      includes.push(`${dir}/*.gguf`)
      for (const p of all) covered.add(p)
    }
  }

  for (const p of selected) if (!covered.has(p)) includes.push(p)
  return includes
}

/** Sum of finished files plus in-flight partials under `dir`. */
async function bytesOnDisk(dir) {
  let total = 0
  async function walk(current, depth) {
    if (depth > 8) return
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, depth + 1)
        continue
      }
      if (!/\.gguf(\.incomplete|\.part)?$/i.test(entry.name) && !entry.name.endsWith('.incomplete')) {
        continue
      }
      try {
        total += (await fsp.stat(abs)).size
      } catch {
        /* vanished mid-poll */
      }
    }
  }
  await walk(dir, 0)
  return total
}

/**
 * Start a model download as a job.
 *
 * Progress is derived from bytes actually on disk against a total fetched from
 * the HF API up front — precise, format-independent, and immune to any change
 * in the CLI's output. The tqdm lines are still captured into the job log for
 * the details panel, but nothing depends on parsing them.
 */
export async function startDownload(ctx, { repo, revision = 'main', include, targetSubdir }) {
  const hf = await which('hf', ['--version'])
  if (!hf.available) {
    throw failedDependency(
      'Die Hugging-Face-CLI (hf) ist nicht installiert. Nachinstallieren mit: pipx install "huggingface_hub[cli]"',
    )
  }

  const token = ctx.config.data.hfToken || ''
  const listing = await listGgufFiles(repo, token, revision)
  const selected = listing.files.filter((f) => include.includes(f.path))
  if (selected.length === 0) {
    throw badRequest('Keine der ausgewählten Dateien existiert in diesem Repository.')
  }

  const totalBytes = selected.reduce((sum, f) => sum + f.size, 0)
  const disk = await diskUsage(ctx.settings.modelsDir)
  if (disk.freeBytes != null && totalBytes > disk.freeBytes) {
    throw failedDependency(
      `Zu wenig Platz: benötigt werden ${fmt(totalBytes)}, frei sind ${fmt(disk.freeBytes)}.`,
    )
  }

  // Default target mirrors the existing layout: <modelsDir>/<repo-name>/…
  const subdir = targetSubdir || repo.split('/').pop()
  const targetDir = safeResolve(ctx.settings.modelsDir, subdir)

  const includes = buildIncludes(
    selected.map((f) => f.path),
    listing.files.map((f) => f.path),
  )

  return ctx.jobs.start(
    {
      type: 'model-download',
      lane: 'model-download',
      title: `${repo} (${fmt(totalBytes)})`,
      meta: { repo, revision, include, targetSubdir: subdir, totalBytes, files: selected.length },
    },
    (jobCtx) => runDownload(ctx, jobCtx, { repo, revision, includes, targetDir, totalBytes }),
  )
}

function runDownload(ctx, { setProgress, appendLog, setMessage, onCancel, signal }, params) {
  const { repo, revision, includes, targetDir, totalBytes } = params

  return new Promise((resolve, reject) => {
    const argv = ['download', repo, '--revision', revision, '--local-dir', targetDir]
    for (const pattern of includes) argv.push('--include', pattern)

    const env = {}
    if (ctx.config.data.hfToken) env.HF_TOKEN = ctx.config.data.hfToken
    env.HF_HUB_ENABLE_HF_TRANSFER = ctx.settings.useHfTransfer ? '1' : '0'
    env.HF_XET_HIGH_PERFORMANCE = '1'

    appendLog(`hf download ${repo} → ${targetDir}`)
    setMessage('Download läuft …')

    const child = stream('hf', argv, {
      env,
      // Own process group, so cancelling reaches the whole download rather than
      // just the wrapper.
      detached: true,
      onStdout: (line) => line.trim() && appendLog(line),
      onStderr: (line) => line.trim() && appendLog(line),
      onExit: (code, sig) => {
        clearInterval(timer)
        if (signal.aborted) {
          // Partials are left on disk on purpose: rerunning the same command
          // resumes them.
          appendLog('Abgebrochen. Teilweise geladene Dateien bleiben für einen Neustart liegen.')
          resolve({ cancelled: true })
          return
        }
        if (code === 0) {
          invalidateModelCache()
          setProgress({ pct: 100, done: totalBytes, total: totalBytes, rate: null, eta: 0 })
          appendLog('Download abgeschlossen.')
          resolve({ repo, targetDir, totalBytes })
        } else {
          reject(
            new AppError(
              502,
              'download_failed',
              `hf download endete mit Code ${code}${sig ? ` (${sig})` : ''}. Details stehen im Job-Log.`,
            ),
          )
        }
      },
    })

    child.on('error', (err) => {
      clearInterval(timer)
      reject(new AppError(500, 'download_failed', `hf konnte nicht gestartet werden: ${err.message}`))
    })

    onCancel(() => {
      try {
        // Negative pid targets the process group created by detached:true.
        process.kill(-child.pid, 'SIGINT')
      } catch (err) {
        log.warn(`Download konnte nicht abgebrochen werden: ${err.message}`)
        child.kill('SIGKILL')
      }
    })

    let lastBytes = 0
    let lastAt = Date.now()
    let rate = null

    const timer = setInterval(async () => {
      const done = await bytesOnDisk(targetDir)
      const now = Date.now()
      const elapsed = (now - lastAt) / 1000
      if (elapsed > 0 && done >= lastBytes) {
        const sample = (done - lastBytes) / elapsed
        rate = rate === null ? sample : rate * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA
      }
      lastBytes = done
      lastAt = now

      const pct = totalBytes > 0 ? Math.min(100, Math.round((done / totalBytes) * 100)) : null
      const remaining = Math.max(0, totalBytes - done)
      setProgress({
        pct,
        done,
        total: totalBytes,
        rate: rate && rate > 0 ? Math.round(rate) : null,
        eta: rate && rate > 0 ? Math.round(remaining / rate) : null,
      })
    }, POLL_MS)
    timer.unref?.()
  })
}

function fmt(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = Number(bytes)
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u += 1
  }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`
}
