import express from 'express'
import fs from 'node:fs'
import path from 'node:path'

import { apiTokenHint, generateApiToken, hashApiToken } from '../auth/apitoken.js'
import { requireSession } from '../auth/middleware.js'
import { settingsPatchSchema } from '../config/schema.js'
import { badRequest, failedDependency } from '../lib/errors.js'
import { mask, registerSecret, unregisterSecret } from '../lib/redact.js'
import { validate } from '../lib/validate.js'

function refreshMediaToken(ctx, token) {
  return ctx.mediaSecrets.refreshHfToken(token)
}

/**
 * Restore the durable config first, then the mounted file. If the process dies
 * between those writes, boot reconciliation uses that config as source of truth.
 */
async function rollbackHfToken(ctx, previous, cause) {
  const failures = []
  try {
    await ctx.config.update((c) => {
      c.hfToken = previous
      return c
    })
  } catch (err) {
    failures.push(`Konfiguration: ${err.code ?? err.message}`)
  }
  try {
    refreshMediaToken(ctx, previous || null)
  } catch (err) {
    failures.push(`Token-Datei: ${err.code ?? err.message}`)
  }
  if (failures.length) {
    throw failedDependency(
      `Die Token-Transaktion ist fehlgeschlagen und konnte nicht vollständig zurückgesetzt werden (${failures.join('; ')}); beim nächsten Start wird sie aus der Konfiguration repariert.`,
    )
  }
  throw cause
}

/**
 * Change the mounted token and durable JSON config as a recoverable transaction.
 * Neither an observed post-rename file nor an in-memory value is proof of a
 * committed rename: every reported fsync error is rolled back and returned.
 */
async function updateHfToken(ctx, nextToken) {
  const previous = ctx.config.data.hfToken
  if (nextToken === previous) {
    try {
      refreshMediaToken(ctx, nextToken || null)
    } catch (err) {
      await rollbackHfToken(ctx, previous, failedDependency(
        `Die Token-Datei der Media API ließ sich nicht dauerhaft abgleichen (${err.code ?? err.message}); bitte erneut versuchen.`,
      ))
    }
    return false
  }

  registerSecret(nextToken)
  try {
    refreshMediaToken(ctx, nextToken || null)
  } catch (err) {
    await rollbackHfToken(ctx, previous, failedDependency(
      `Die Token-Datei der Media API ließ sich nicht dauerhaft schreiben (${err.code ?? err.message}); die Änderung wurde zurückgesetzt — bitte erneut versuchen.`,
    ))
  }
  try {
    await ctx.config.update((c) => {
      c.hfToken = nextToken
      return c
    })
  } catch (writeError) {
    await rollbackHfToken(ctx, previous, writeError)
  }
  if (previous && previous !== nextToken) unregisterSecret(previous)
  return true
}

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

      if (hfToken !== undefined) await updateHfToken(ctx, hfToken)
      await ctx.config.update((c) => {
        c.settings = { ...c.settings, ...patch }
        return c
      })
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
      if (!previous) {
        // Repair an interrupted delete whose config committed before the
        // mounted directory received its empty token file.
        refreshMediaToken(ctx, null)
        return res.json({ ok: true, wasSet: false })
      }
      await updateHfToken(ctx, '')
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
