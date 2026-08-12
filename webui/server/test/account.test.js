import assert from 'node:assert/strict'
import { test } from 'node:test'

import { USERNAME_RE } from '../../shared/constants.js'
import { requireAuth } from '../src/auth/middleware.js'
import { generateSecret, signToken } from '../src/auth/tokens.js'

/* ------------------------------ username rules ------------------------------ */

test('accepts ordinary and email-style login names', () => {
  for (const name of ['admin', 'stefan', 'st3v0rr', 'a.b_c-d', 'user@example.com', 'a+tag']) {
    assert.ok(USERNAME_RE.test(name), name)
  }
})

test('rejects names that could be visually confused or break parsing', () => {
  for (const name of [
    '',
    ' admin',
    'admin ',
    'has space',
    '.leading-dot',
    '-leading-dash',
    'tab\there',
    'new\nline',
    'sch√∂n', // non-ASCII: two names could render alike
    'a'.repeat(65),
  ]) {
    assert.ok(!USERNAME_RE.test(name), `should reject ${JSON.stringify(name)}`)
  }
})

test('accepts a name of exactly the maximum length', () => {
  assert.ok(USERNAME_RE.test('a'.repeat(64)))
})

/* --------------------------- session invalidation --------------------------- */

function fakeRes() {
  return {
    cookies: [],
    cleared: [],
    cookie(name, value) {
      this.cookies.push({ name, value })
    },
    clearCookie(name) {
      this.cleared.push(name)
    },
  }
}

function fakeReq(token) {
  return { cookies: { shx_token: token }, get: () => undefined, secure: false }
}

function runAuth(config, token) {
  const res = fakeRes()
  return new Promise((resolve) => {
    requireAuth(() => config)(fakeReq(token), res, (err) => resolve({ err: err ?? null, res }))
  })
}

const now = () => Math.floor(Date.now() / 1000)

test('a token issued before the credentials changed is rejected', async () => {
  // The point of the whole mechanism: changing a password because you suspect
  // a compromise must not leave the attacker's session alive for 12 hours.
  const secret = generateSecret()
  const token = await signToken(secret, { sub: 'admin' })
  const config = { jwtSecret: secret, username: 'admin', credentialsChangedAt: now() + 60 }

  const { err, res } = await runAuth(config, token)
  assert.equal(err?.status, 401)
  assert.match(err.message, /Zugangsdaten/)
  assert.deepEqual(res.cleared, ['shx_token'])
})

test('a token issued after the change is accepted', async () => {
  const secret = generateSecret()
  const config = { jwtSecret: secret, username: 'admin', credentialsChangedAt: now() - 60 }
  const token = await signToken(secret, { sub: 'admin' })

  const { err } = await runAuth(config, token)
  assert.equal(err, null)
})

test('a token naming the old username is rejected after a rename', async () => {
  const secret = generateSecret()
  const token = await signToken(secret, { sub: 'admin' })
  const config = { jwtSecret: secret, username: 'stefan', credentialsChangedAt: 0 }

  const { err, res } = await runAuth(config, token)
  assert.equal(err?.status, 401)
  assert.match(err.message, /Benutzername/)
  assert.deepEqual(res.cleared, ['shx_token'])
})

test('a config without the cutoff field still authenticates', async () => {
  // Configs written before this feature existed have no credentialsChangedAt.
  const secret = generateSecret()
  const token = await signToken(secret, { sub: 'admin' })
  const { err } = await runAuth({ jwtSecret: secret, username: 'admin' }, token)
  assert.equal(err, null)
})

test('a token issued in the same second as the change survives', async () => {
  // The endpoint stamps the cutoff and signs a replacement token in the same
  // second; a >= comparison would log the user out of the tab they are using.
  const secret = generateSecret()
  const stamp = now()
  const token = await signToken(secret, { sub: 'admin' })
  const { err } = await runAuth(
    { jwtSecret: secret, username: 'admin', credentialsChangedAt: stamp },
    token,
  )
  assert.equal(err, null)
})
