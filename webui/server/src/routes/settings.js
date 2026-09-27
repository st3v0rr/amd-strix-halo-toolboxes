import express from 'express'
import fs from 'node:fs'
import path from 'node:path'

import { apiTokenHint, generateApiToken, hashApiToken } from '../auth/apitoken.js'
import { requireSession } from '../auth/middleware.js'
import { settingsPatchSchema } from '../config/schema.js'
import { badRequest } from '../lib/errors.js'
import { mask, registerSecret, unregisterSecret } from '../lib/redact.js'
import { validate } from '../lib/validate.js'

export function settingsRoutes(ctx) {
  const router = express.Router()

  router.get('/', (req, res) => {
    const config = ctx.config.data
    res.json({
      settings: config.settings,
      // Write-only: the token itself is never handed back out.
      hfToken: { configured: Boolean(config.hfToken), hint: mask(config.hfToken) },
      apiToken: config.apiToken
        ? { configured: true, hint: config.apiToken.hint, createdAt: config.apiToken.createdAt }
        : { configured: false },
      username: config.username,
    })
  })

  router.put('/', validate({ body: settingsPatchSchema }), async (req, res, next) => {
    try {
      const { hfToken, ...patch } = req.body

      if (patch.modelsDir !== undefined) {
        if (!path.isAbsolute(patch.modelsDir)) {
          throw badRequest('Das Modellverzeichnis muss ein absoluter Pfad sein.')
        }
        try {
          fs.mkdirSync(patch.modelsDir, { recursive: true })
        } catch (err) {
          throw badRequest(`Modellverzeichnis nicht nutzbar: ${err.message}`)
        }
      }

      const previousToken = ctx.config.data.hfToken
      await ctx.config.update((c) => {
        c.settings = { ...c.settings, ...patch }
        if (hfToken !== undefined) c.hfToken = hfToken
        return c
      })

      if (hfToken !== undefined && hfToken !== previousToken) {
        unregisterSecret(previousToken)
        registerSecret(hfToken)
      }
      if (patch.maxConcurrentDownloads !== undefined) {
        ctx.jobs.configureLane('model-download', patch.maxConcurrentDownloads)
      }

      res.json({ settings: ctx.config.data.settings })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Remove the stored token.
   *
   * A separate route rather than `PUT {hfToken: ''}`: the settings form treats
   * an empty password field as "leave unchanged", so there would otherwise be
   * no way to express "clear it" at all.
   */
  router.delete('/hf-token', async (req, res, next) => {
    try {
      const previous = ctx.config.data.hfToken
      if (!previous) return res.json({ ok: true, wasSet: false })

      await ctx.config.update((c) => {
        c.hfToken = ''
        return c
      })
      await ctx.config.flush()
      unregisterSecret(previous)
      ctx.log.info('Hugging-Face-Token entfernt.')
      res.json({ ok: true, wasSet: true })
    } catch (err) {
      next(err)
    }
  })

  /**
   * Issue the API token for MCP clients, replacing any previous one.
   *
   * The response is the only place the plain token ever appears; the config
   * keeps its hash. Losing it means issuing a new one, which is cheap.
   */
  router.post('/api-token', requireSession, async (req, res, next) => {
    try {
      const token = generateApiToken()
      const apiToken = {
        hash: hashApiToken(token),
        hint: apiTokenHint(token),
        createdAt: new Date().toISOString(),
      }
      const replaced = Boolean(ctx.config.data.apiToken)
      await ctx.config.update((c) => {
        c.apiToken = apiToken
        return c
      })
      await ctx.config.flush()
      ctx.log.info(replaced ? 'API-Token ersetzt.' : 'API-Token erzeugt.')
      res.status(201).json({ token, hint: apiToken.hint, createdAt: apiToken.createdAt, replaced })
    } catch (err) {
      next(err)
    }
  })

  router.delete('/api-token', requireSession, async (req, res, next) => {
    try {
      const wasSet = Boolean(ctx.config.data.apiToken)
      if (wasSet) {
        await ctx.config.update((c) => {
          c.apiToken = null
          return c
        })
        await ctx.config.flush()
        ctx.log.info('API-Token widerrufen.')
      }
      res.json({ ok: true, wasSet })
    } catch (err) {
      next(err)
    }
  })

  return router
}
