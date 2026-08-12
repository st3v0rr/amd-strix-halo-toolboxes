import express from 'express'
import { z } from 'zod'

import { AUTH_COOKIE, MIN_PASSWORD_LENGTH, USERNAME_RE } from '../../../shared/constants.js'
import { badRequest, unauthorized } from '../lib/errors.js'
import { registerSecret, unregisterSecret } from '../lib/redact.js'
import { validate } from '../lib/validate.js'
import { cookieOptions, makeLoginLimiter, requireAuth } from './middleware.js'
import { generatePassword, hashPassword, verifyPassword } from './password.js'
import { TOKEN_TTL_SECONDS, generateSecret, signToken } from './tokens.js'

const loginBody = z.object({
  username: z.string().min(1).max(128).optional(),
  password: z.string().min(1).max(1024),
})

/**
 * One endpoint for both, because both need the same proof: the current
 * password. Splitting them would mean typing it twice to change both.
 */
const accountBody = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    username: z
      .string()
      .regex(USERNAME_RE, {
        message:
          'Erlaubt sind Buchstaben, Ziffern und . _ - @ + (max. 64 Zeichen, keine Leerzeichen).',
      })
      .optional(),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, { message: `Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.` })
      .max(1024)
      .optional(),
  })
  .refine((body) => body.username !== undefined || body.newPassword !== undefined, {
    message: 'Es muss ein neuer Benutzername oder ein neues Passwort angegeben werden.',
  })

export function authRoutes(ctx) {
  const router = express.Router()
  const login = makeLoginLimiter()
  const auth = requireAuth(ctx.getConfig)

  router.post('/login', login.limiter, validate({ body: loginBody }), async (req, res, next) => {
    try {
      const config = ctx.config.data
      if (!config.passwordHash) {
        throw badRequest(
          'Es ist noch kein Passwort gesetzt. Führe webui/install.sh aus oder setze eines mit webui/scripts/shx-passwd.',
        )
      }

      await login.penalty()
      const { username, password } = req.body
      const userOk = !username || username === config.username
      const passOk = await verifyPassword(password, config.passwordHash)

      if (!userOk || !passOk) {
        login.noteFailure()
        ctx.log.warn(`Fehlgeschlagener Anmeldeversuch von ${req.ip}`)
        throw unauthorized('Benutzername oder Passwort ist falsch.')
      }

      login.noteSuccess()
      const token = await signToken(config.jwtSecret, { sub: config.username })
      res.cookie(AUTH_COOKIE, token, cookieOptions(req))
      res.json({
        username: config.username,
        expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
      })
    } catch (err) {
      next(err)
    }
  })

  router.post('/logout', (req, res) => {
    res.clearCookie(AUTH_COOKIE, { ...cookieOptions(req), maxAge: undefined })
    res.json({ ok: true })
  })

  router.get('/me', auth, (req, res) => {
    res.json({
      username: req.user.username,
      expiresAt: new Date(req.user.expiresAt * 1000).toISOString(),
    })
  })

  router.post('/account', auth, validate({ body: accountBody }), async (req, res, next) => {
    try {
      const config = ctx.config.data
      const ok = await verifyPassword(req.body.currentPassword, config.passwordHash)
      if (!ok) {
        // Rate-limited like a login: this endpoint verifies a password too, so
        // it would otherwise be the softer way to guess one.
        login.noteFailure()
        ctx.log.warn(`Fehlgeschlagene Kontoänderung von ${req.ip}`)
        throw unauthorized('Das aktuelle Passwort ist falsch.')
      }

      // `config` is a live reference to the store's data, so anything we want
      // to compare against has to be captured before the update below.
      const previousUsername = config.username
      const username = req.body.username ?? previousUsername
      const changingPassword = req.body.newPassword !== undefined

      const changed = [
        username !== previousUsername ? 'Benutzername' : null,
        changingPassword ? 'Passwort' : null,
      ].filter(Boolean)

      // Resubmitting the unchanged name with no new password changes nothing.
      // Saying so beats invalidating every session for a no-op.
      if (changed.length === 0) {
        throw badRequest('Es ändert sich nichts: Der Benutzername ist bereits so gesetzt.')
      }

      const hash = changingPassword ? await hashPassword(req.body.newPassword) : config.passwordHash

      // Second-resolution timestamps are what the JWT `iat` claim carries, so
      // the cutoff has to be in the same unit.
      const now = Math.floor(Date.now() / 1000)

      await ctx.config.update((c) => {
        c.username = username
        c.passwordHash = hash
        c.credentialsChangedAt = now
        return c
      })
      await ctx.config.flush()

      ctx.log.info(`${changed.join(' und ')} geändert.`)

      // Every previously issued token is now older than credentialsChangedAt,
      // including this request's — so hand out a fresh one rather than logging
      // the user out of the tab they are working in.
      const token = await signToken(config.jwtSecret, { sub: username })
      res.cookie(AUTH_COOKIE, token, cookieOptions(req))

      res.json({
        username,
        changed,
        expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
      })
    } catch (err) {
      next(err)
    }
  })

  // Rotating the secret invalidates every issued token, including our own.
  router.post('/rotate-secret', auth, async (req, res, next) => {
    try {
      const old = ctx.config.data.jwtSecret
      const secret = generateSecret()
      await ctx.config.update((c) => {
        c.jwtSecret = secret
        c.credentialsChangedAt = Math.floor(Date.now() / 1000)
        return c
      })
      unregisterSecret(old)
      registerSecret(secret)
      res.clearCookie(AUTH_COOKIE, { ...cookieOptions(req), maxAge: undefined })
      ctx.log.info('JWT-Secret rotiert, alle Sitzungen wurden abgemeldet.')
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  return router
}

export { generatePassword }
