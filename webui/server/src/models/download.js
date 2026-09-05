import fsp from 'node:fs/promises'
import path from 'node:path'

import { JOB_FINISHED_STATUS } from '../../../shared/constants.js'
import { AppError, badRequest, conflict, failedDependency } from '../lib/errors.js'
import { stream, which } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { listGgufFiles } from './hfapi.js'
import { HfProgress } from './hfprogress.js'
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
 * Bytes of the selected files that are already there from an earlier attempt.
 *
 * Three places have to be looked at: the finished file at its final path, and
 * the partial one, which current `huggingface_hub` parks under
 * `.cache/huggingface/download/<path>.incomplete` while older versions put it
 * next to the target. Only the selected paths are counted — other quants
 * sitting in the same repository folder are none of this download's business.
 *
 * @param {string} targetDir
 * @param {{path: string, size: number}[]} selected
 */
export async function resumableBytes(targetDir, selected) {
  let total = 0
  for (const file of selected) {
    const candidates = [
      path.join(targetDir, file.path),
      path.join(targetDir, '.cache', 'huggingface', 'download', `${file.path}.incomplete`),
      path.join(targetDir, `${file.path}.incomplete`),
    ]
    for (const abs of candidates) {
      try {
        const { size } = await fsp.stat(abs)
        total += Math.min(size, file.size)
        break
      } catch {
        /* not there yet */
      }
    }
  }
  return total
}

/**
 * Start a model download as a job.
 *
 * The total is fetched from the HF API up front, so it is exact from the first
 * tick. Progress against it comes from two sources, whichever is further along:
 *
 *  - bytes on disk in the target directory — precise and independent of the
 *    CLI's output format, but stuck at zero when Xet storage is in play,
 *    because chunks land in a cache elsewhere and the file only materialises
 *    at the end;
 *  - the CLI's own tqdm percentages (see hfprogress.js), which cover exactly
 *    that case.
 *
 * Relying on the first alone is what made a 6 GB Xet download show no progress
 * at all and then jump straight to done.
 */
export async function startDownload(ctx, { repo, revision = 'main', include, targetSubdir }) {
  const hf = await which('hf', ['--version'])
  if (!hf.available) {
    throw failedDependency(
      'Die Hugging-Face-CLI (hf) wurde nicht gefunden. Falls sie installiert ist, liegt sie ' +
        'vermutlich in einem Verzeichnis, das der Dienst nicht durchsucht — trage den vollen ' +
        'Pfad als SHX_HF_BIN in ~/.config/strix-halo-webui/env ein und starte den Dienst neu ' +
        '(hf findest du mit "command -v hf"). Andernfalls installieren mit: ' +
        'pipx install "huggingface_hub[cli]"',
    )
  }

  const token = ctx.config.data.hfToken || ''
  const listing = await listGgufFiles(repo, token, revision)
  const selected = listing.files.filter((f) => include.includes(f.path))
  if (selected.length === 0) {
    throw badRequest('Keine der ausgewählten Dateien existiert in diesem Repository.')
  }

  // Default target mirrors the existing layout: <modelsDir>/<repo-name>/…
  const subdir = targetSubdir || repo.split('/').pop()
  const targetDir = safeResolve(ctx.settings.modelsDir, subdir)

  // Two jobs writing the same files would fight over the partials, and the
  // progress figures of both would be nonsense. The UI offers a resume button
  // on every unfinished download, so this is mostly a double-click guard.
  const running = ctx.jobs
    .list({ type: 'model-download' })
    .find(
      (j) =>
        !JOB_FINISHED_STATUS.includes(j.status) &&
        j.meta?.repo === repo &&
        j.meta?.targetSubdir === subdir,
    )
  if (running) {
    throw conflict(
      `Für ${repo} läuft bereits ein Download. Warte ihn ab oder brich ihn unter "Llama.cpp-Modelle" ab.`,
      { jobId: running.id },
    )
  }

  const totalBytes = selected.reduce((sum, f) => sum + f.size, 0)
  // Only what is still missing has to fit — a resumed download brings its
  // partial files along.
  const missingBytes = Math.max(0, totalBytes - (await resumableBytes(targetDir, selected)))
  const disk = await diskUsage(ctx.settings.modelsDir)
  if (disk.freeBytes != null && missingBytes > disk.freeBytes) {
    throw failedDependency(
      `Zu wenig Platz: benötigt werden ${fmt(missingBytes)}, frei sind ${fmt(disk.freeBytes)}.`,
    )
  }

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
    (jobCtx) =>
      runDownload(ctx, jobCtx, { repo, revision, includes, targetDir, totalBytes, selected }),
  )
}

function runDownload(ctx, { setProgress, appendLog, setMessage, onCancel, signal }, params) {
  const { repo, revision, includes, targetDir, totalBytes, selected } = params

  // Two independent progress sources; see hfprogress.js for why.
  const cliProgress = new HfProgress(selected)

  return new Promise((resolve, reject) => {
    const argv = ['download', repo, '--revision', revision, '--local-dir', targetDir]
    for (const pattern of includes) argv.push('--include', pattern)

    const env = {}
    if (ctx.config.data.hfToken) env.HF_TOKEN = ctx.config.data.hfToken
    env.HF_HUB_ENABLE_HF_TRANSFER = ctx.settings.useHfTransfer ? '1' : '0'
    if (ctx.settings.disableXet) {
      // Falls back to plain HTTPS range requests. Slower when the Xet cache
      // would have had the chunks, but it does not stall.
      env.HF_HUB_DISABLE_XET = '1'
    } else {
      env.HF_XET_HIGH_PERFORMANCE = '1'
    }

    appendLog(`hf download ${repo} → ${targetDir}`)
    setMessage('Download läuft …')

    const child = stream('hf', argv, {
      env,
      // Own process group, so cancelling reaches the whole download rather than
      // just the wrapper.
      detached: true,
      onStdout: (line) => line.trim() && appendLog(line),
      onStderr: (line) => {
        cliProgress.push(line)
        if (line.trim()) appendLog(line)
      },
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
          appendLog(
            cliProgress.xet
              ? 'Download abgeschlossen (Xet-Storage: Teile kamen aus dem lokalen Cache).'
              : 'Download abgeschlossen.',
          )
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

    let maxDone = 0
    const timer = setInterval(async () => {
      // Bytes on disk are precise but stay at zero under Xet; the CLI's own
      // reporting covers that case. Whichever is further along is the truth,
      // and the figure never moves backwards.
      const measured = Math.max(await bytesOnDisk(targetDir), cliProgress.doneBytes)
      maxDone = Math.max(maxDone, measured)
      const done = maxDone
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
