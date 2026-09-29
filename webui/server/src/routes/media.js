import express from 'express'
import { z } from 'zod'

import { requireSession } from '../auth/middleware.js'
import { validate } from '../lib/validate.js'
import {
  assertMediaImageAllowed,
  mediaConfigPatchSchema,
  resolveMediaConfig,
  saveMediaConfig,
} from '../media/config.js'
import { resumeMediaFetch, startMediaFetch } from '../media/fetch.js'
import { invalidateMediaInventory, mediaInventory } from '../media/models.js'
import { mediaStatus } from '../media/service.js'
import { createMediaServer } from '../podman/servers.js'

const ID = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)

const applyBody = z.object({ replace: z.boolean().optional() })
const fetchBody = z.object({ model: ID, profile: ID.optional(), task: ID.optional() })
const keyBody = z.object({ value: z.string().min(1).max(512) })

/**
 * The media API: one service per box, run as a managed container.
 *
 * It is started from the Servers page (POST /api/servers with role `media`),
 * and stopping, restarting, removing, logs and health go through
 * /api/servers/:name like every other container. What lives here is what only
 * this service has: its status, its full settings (for the API — the page
 * offers only the few the start dialog asks), its secrets, the model
 * inventory of its image and the fetches.
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
   * Save settings. Nothing is applied to a running container: it takes the
   * settings only once it has been removed explicitly and started again; the
   * status reports the difference until then.
   */
  router.put('/config', validate({ body: mediaConfigPatchSchema }), async (req, res, next) => {
    try {
      await saveMediaConfig(ctx, resolveMediaConfig(ctx, req.body))
      invalidateMediaInventory()
      res.json({ config: ctx.media.data })
    } catch (err) {
      next(err)
    }
  })

  /** Create the container from the saved settings. An existing one is never replaced — it must be removed first. */
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
