import fs from 'node:fs'

import {
  COMFY_CONTAINER_MODELS_DIR,
  JOB_FINISHED_STATUS,
} from '../../../shared/constants.js'
import { findComfyDownload } from '../../../shared/comfycatalog.js'
import { badRequest, conflict, failedDependency, notFound } from '../lib/errors.js'
import { stream } from '../lib/exec.js'
import { log } from '../lib/log.js'
import { invalidateComfyModelCache } from './comfyscan.js'

/**
 * Download a ComfyUI model set by running the image's own get_*.sh.
 *
 * The scripts that ship in kyuz0's image already know every repository, file
 * and target subfolder, and resume through a staging directory. Reimplementing
 * that here would mean maintaining a second copy of a list that changes
 * whenever a new model comes out — so instead a throwaway container runs the
 * real script with the host's model directory mounted where it expects it.
 *
 * @param {object} ctx app context
 * @param {{id: string, image: string}} params catalog id and the ComfyUI image to run
 */
export async function startComfyDownload(ctx, { id, image }) {
  // The catalog is the only source of arguments. Nothing the client sends
  // reaches the command line — these run inside a shell in the container.
  const entry = findComfyDownload(id)
  if (!entry) throw notFound(`Unbekannter Download '${id}'.`)

  if (!image) throw badRequest('Kein ComfyUI-Image angegeben.')

  const modelsDir = ctx.settings.comfyModelsDir
  try {
    fs.mkdirSync(modelsDir, { recursive: true })
  } catch (err) {
    throw failedDependency(`Verzeichnis ${modelsDir} lässt sich nicht anlegen: ${err.message}`)
  }

  // Two runs of the same set would fight over the staging directory.
  const running = ctx.jobs
    .list({ type: 'comfy-model-download' })
    .find((j) => !JOB_FINISHED_STATUS.includes(j.status) && j.meta?.downloadId === id)
  if (running) {
    throw conflict(`Für '${entry.label}' läuft bereits ein Download.`, { jobId: running.id })
  }

  const token = ctx.config.data.hfToken || ''

  return ctx.jobs.start(
    {
      type: 'comfy-model-download',
      // Same lane as the GGUF downloads: both saturate the same network link,
      // and running them together only makes each one slower.
      lane: 'model-download',
      title: `${entry.family}: ${entry.label}`,
      meta: { downloadId: id, family: entry.family, label: entry.label, image },
    },
    (jobCtx) => runComfyDownload(jobCtx, { entry, image, modelsDir, token }),
  )
}

function runComfyDownload({ appendLog, setMessage, onCancel, signal }, params) {
  const { entry, image, modelsDir, token } = params

  return new Promise((resolve, reject) => {
    const argv = [
      'run',
      '--rm',
      '-v',
      `${modelsDir}:${COMFY_CONTAINER_MODELS_DIR}:z`,
    ]
    // Gated repositories need the token; ungated ones ignore it. Passed as an
    // environment variable rather than on the command line, where it would
    // show up in `podman ps` for every user on the box.
    if (token) argv.push('-e', `HF_TOKEN=${token}`)
    argv.push(image, `/opt/${entry.script}`, ...entry.args)

    setMessage(`Lade ${entry.label} …`)

    // The scripts have no machine-readable progress — they shell out to `hf`
    // per file — but they do announce each step. Surfacing those lines as the
    // job's message turns an otherwise blank bar into "which file are we on".
    const step = (line) => {
      appendLog(line)
      const t = line.trim()
      if (t.startsWith('==>') || t.startsWith('✓')) setMessage(t.replace(/^==>\s*/, ''))
    }

    const child = stream('podman', argv, {
      onStdout: step,
      onStderr: step,
      onExit: (code) => {
        invalidateComfyModelCache()
        if (signal?.aborted) {
          reject(new Error('Abgebrochen.'))
          return
        }
        if (code === 0) {
          setMessage(`${entry.label} geladen.`)
          resolve({ downloadId: entry.id })
        } else {
          reject(new Error(`Der Download brach mit Status ${code} ab.`))
        }
      },
    })

    onCancel(() => {
      log.info(`ComfyUI-Download '${entry.id}' wird abgebrochen.`)
      // The script itself keeps its staging directory, so the next attempt
      // resumes rather than starting over.
      child.kill('SIGTERM')
    })
  })
}
