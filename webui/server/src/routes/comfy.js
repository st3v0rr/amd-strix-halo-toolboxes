import fsp from 'node:fs/promises'
import path from 'node:path'

import express from 'express'
import { z } from 'zod'

import { COMFY_CATALOG } from '../../../shared/comfycatalog.js'
import { ROLE } from '../../../shared/constants.js'
import { startComfyDownload } from '../models/comfydownload.js'
import { comfyDiskUsage, invalidateComfyModelCache, scanComfyModels } from '../models/comfyscan.js'
import { conflict, notFound } from '../lib/errors.js'
import { q, validate } from '../lib/validate.js'
import { safeResolve } from '../models/paths.js'
import { listServers } from '../podman/servers.js'

const deleteQuery = z.object({ rel: z.string().min(1).max(1000) })

const downloadBody = z.object({
  id: z.string().min(1).max(100),
  image: z.string().min(1).max(400),
})

export function comfyRoutes(ctx) {
  const router = express.Router()
  const modelsDir = () => ctx.settings.comfyModelsDir

  router.get('/models', async (req, res, next) => {
    try {
      const [scan, disk] = await Promise.all([
        scanComfyModels(modelsDir()),
        comfyDiskUsage(modelsDir()),
      ])
      res.json({ ...scan, disk })
    } catch (err) {
      next(err)
    }
  })

  router.post('/models/refresh', async (req, res, next) => {
    try {
      invalidateComfyModelCache()
      const [scan, disk] = await Promise.all([
        scanComfyModels(modelsDir(), { force: true }),
        comfyDiskUsage(modelsDir()),
      ])
      res.json({ ...scan, disk })
    } catch (err) {
      next(err)
    }
  })

  router.delete('/models', validate({ query: deleteQuery }), async (req, res, next) => {
    try {
      const { rel } = q(req)
      const abs = safeResolve(modelsDir(), rel)

      // Unlike a llama server, whose model is named in its own labels, a
      // running ComfyUI says nothing about which files a workflow is about to
      // load. So the rule is coarser on purpose: stop ComfyUI first.
      const running = (await listServers()).filter((s) => s.role === ROLE.comfy && s.running)
      if (running.length) {
        throw conflict(
          `ComfyUI läuft (${running.map((s) => `'${s.name}'`).join(', ')}). Welche Datei ein ` +
            'Workflow gerade braucht, lässt sich von außen nicht sagen — stoppe ComfyUI vor dem Löschen.',
          { servers: running.map((s) => s.name) },
        )
      }

      let freed = 0
      try {
        const stat = await fsp.stat(abs)
        freed = stat.size
        await fsp.rm(abs)
      } catch (err) {
        if (err.code === 'ENOENT') throw notFound(`Keine Datei '${rel}'.`)
        throw err
      }

      invalidateComfyModelCache()
      res.json({ deleted: [rel], freedBytes: freed })
    } catch (err) {
      next(err)
    }
  })

  /** The download sets upstream's image can fetch. Static data, no I/O. */
  router.get('/catalog', (req, res) => {
    res.json({ catalog: COMFY_CATALOG })
  })

  router.post('/downloads', validate({ body: downloadBody }), async (req, res, next) => {
    try {
      const job = await startComfyDownload(ctx, req.body)
      res.status(202).json({ job })
    } catch (err) {
      next(err)
    }
  })

  /** Where generated images and videos land, newest first. */
  router.get('/outputs', async (req, res, next) => {
    try {
      const dir = ctx.settings.comfyOutputDir
      let files = []
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true })
        files = (
          await Promise.all(
            entries
              .filter((e) => e.isFile() && !e.name.startsWith('.'))
              .map(async (e) => {
                const stat = await fsp.stat(path.join(dir, e.name))
                return { file: e.name, size: stat.size, mtime: stat.mtime.toISOString() }
              }),
          )
        ).sort((a, b) => b.mtime.localeCompare(a.mtime))
      } catch {
        /* not created yet — an empty list is the honest answer */
      }
      res.json({ outputDir: dir, files: files.slice(0, 200), total: files.length })
    } catch (err) {
      next(err)
    }
  })

  return router
}
