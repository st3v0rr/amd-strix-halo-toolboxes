import express from 'express'
import { z } from 'zod'

import { requireSession } from '../auth/middleware.js'
import { mediaConfigSchema } from '../config/schema.js'
import { badRequest } from '../lib/errors.js'
import { validate } from '../lib/validate.js'
import { assertMediaImageAllowed, checkMediaConfig, mediaConfigPatchSchema } from '../media/config.js'
import { resumeMediaFetch, startMediaFetch } from '../media/fetch.js'
import { invalidateMediaInventory, mediaInventory } from '../media/models.js'
import { mediaStatus } from '../media/service.js'
import { createMediaServer } from '../podman/servers.js'

const ID = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

const applyBody = z.object({ replace: z.boolean().optional() })
const fetchBody = z.object({ model: ID, profile: ID.optional(), task: ID.optional() })
const keyBody = z.object({ value: z.string().min(1).max(512) })

/**
 * The media API: one service per box, configured here and run as a managed
 * container.
 *
 * Starting, stopping, restarting, removing, logs and health go through
 * /api/servers/:name like every other container — the media role is just one
 * more kind there. What lives here is what only this service has: its
 * settings, its secrets, the model inventory of its image and the fetches.
 */
export function mediaRoutes(ctx) {
  const router = express.Router()

  router.get('/', async (req, res, next) => {
    try {
      res.json(await mediaStatus(ctx))
    } catch (err) {
      next(err)
    }
  })

  /**
   * Save settings. Nothing is applied to a running container: that is what
   * /apply is for, and the status reports the difference until then.
   */
  router.put('/config', validate({ body: mediaConfigPatchSchema }), async (req, res, next) => {
    try {
      const merged = mediaConfigSchema.safeParse({ ...ctx.media.data, ...req.body })
      if (!merged.success) {
        const issue = merged.error.issues[0]
        throw badRequest(`Ungültige Eingabe bei ${issue.path.join('.')}: ${issue.message}`)
      }
      const updated = { ...merged.data, updatedAt: new Date().toISOString() }
      assertMediaImageAllowed(ctx, updated.image)
      const { modelsDir, dataDir } = checkMediaConfig(ctx, updated)
      // Stored normalized, so the drift check compares like with like.
      updated.dataDir = dataDir
      if (updated.modelsDir) updated.modelsDir = modelsDir
      await ctx.media.update(() => updated)
      await ctx.media.flush()
      invalidateMediaInventory()
      res.json({ config: ctx.media.data })
    } catch (err) {
      next(err)
    }
  })

  /** Create the container from the saved settings, or replace it with `replace`. */
  router.post('/apply', validate({ body: applyBody }), async (req, res, next) => {
    try {
      const logs = []
      const result = await createMediaServer(ctx, {
        replace: req.body.replace === true,
        onLog: (line) => logs.push(line),
      })
      invalidateMediaInventory()
      res.status(201).json({ ...result, logs })
    } catch (err) {
      next(err)
    }
  })

  router.get('/models', async (req, res, next) => {
    try {
      assertMediaImageAllowed(ctx, ctx.media.data.image)
      res.json(await mediaInventory(ctx))
    } catch (err) {
      next(err)
    }
  })

  router.post('/models/refresh', async (req, res, next) => {
    try {
      assertMediaImageAllowed(ctx, ctx.media.data.image)
      res.json(await mediaInventory(ctx, { force: true }))
    } catch (err) {
      next(err)
    }
  })

  router.post('/fetch', validate({ body: fetchBody }), async (req, res, next) => {
    try {
      const job = await startMediaFetch(ctx, req.body)
      res.status(202).json({ jobId: job.id, job: job.toJSON() })
    } catch (err) {
      next(err)
    }
  })

  router.post('/fetch/:id/resume', async (req, res, next) => {
    try {
      const job = await resumeMediaFetch(ctx, req.params.id)
      res.status(202).json({ jobId: job.id, job: job.toJSON() })
    } catch (err) {
      next(err)
    }
  })

  /*
   * Secrets: browser session only. An agent with the API token runs the box,
   * but replacing the service's key would lock the owner's clients out, and
   * choosing it would hand the agent a key it was never shown. Responses carry
   * fingerprints, never values.
   */
  router.post('/secrets/api-key', requireSession, (req, res, next) => {
    try {
      const status = ctx.mediaSecrets.rotate('apiKey')
      ctx.log.info('Media-API-Schlüssel neu erzeugt.')
      res.json({ secrets: status, restartRequired: true })
    } catch (err) {
      next(err)
    }
  })

  router.put('/secrets/api-key', requireSession, validate({ body: keyBody }), (req, res, next) => {
    try {
      const status = ctx.mediaSecrets.setApiKey(req.body.value)
      ctx.log.info('Media-API-Schlüssel gesetzt.')
      res.json({ secrets: status, restartRequired: true })
    } catch (err) {
      next(err)
    }
  })

  router.post('/secrets/session-secret', requireSession, (req, res, next) => {
    try {
      const status = ctx.mediaSecrets.rotate('sessionSecret')
      ctx.log.info('Media-API-Sitzungsgeheimnis neu erzeugt.')
      res.json({ secrets: status, restartRequired: true })
    } catch (err) {
      next(err)
    }
  })

  return router
}
