#!/usr/bin/env node
/**
 * Reset the admin password (and, if missing, bootstrap the config) from a
 * shell. This is the recovery path — there is deliberately no open `/setup`
 * endpoint that anyone on the LAN could reach first.
 *
 * Usage:
 *   shx-passwd                     prompt for a new password
 *   shx-passwd --generate          generate one and print it
 *   shx-passwd --stdin             read it from stdin (for scripting)
 *   shx-passwd --username <name>   also (or only) change the login name
 */
import readline from 'node:readline'

import { configFile, ensureDirs } from '../config/paths.js'
import { configSchema } from '../config/schema.js'
import { JsonStore } from '../config/store.js'
import { USERNAME_RE } from '../../../shared/constants.js'
import { generatePassword, hashPassword } from '../auth/password.js'
import { generateSecret } from '../auth/tokens.js'

const args = process.argv.slice(2)

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const onData = (char) => {
      // Redraw the prompt without echoing what was typed.
      const s = String(char)
      if (s === '\n' || s === '\r' || s === '') {
        process.stdin.removeListener('data', onData)
      } else {
        readline.clearLine(process.stdout, 0)
        readline.cursorTo(process.stdout, 0)
        process.stdout.write(prompt)
      }
    }
    process.stdin.on('data', onData)
    rl.question(prompt, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    rl.on('error', reject)
  })
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function main() {
  ensureDirs()
  const store = new JsonStore({ file: configFile, schema: configSchema, mode: 0o600 })
  store.load()

  // --username alone is a valid invocation: rename without touching the
  // password.
  const nameIndex = args.indexOf('--username')
  const newUsername = nameIndex >= 0 ? args[nameIndex + 1] : null
  if (nameIndex >= 0) {
    if (!newUsername || !USERNAME_RE.test(newUsername)) {
      process.stderr.write(
        'Ungültiger Benutzername. Erlaubt sind Buchstaben, Ziffern und . _ - @ + (max. 64 Zeichen).\n',
      )
      process.exit(1)
    }
  }
  const onlyRename = nameIndex >= 0 && !args.includes('--generate') && !args.includes('--stdin')

  let password
  let generated = false
  if (onlyRename) {
    password = null
  } else if (args.includes('--generate')) {
    password = generatePassword()
    generated = true
  } else if (args.includes('--stdin')) {
    password = await readStdin()
  } else {
    password = await readHidden('Neues Passwort: ')
    const again = await readHidden('Wiederholen:    ')
    if (password !== again) {
      process.stderr.write('Die Passwörter stimmen nicht überein.\n')
      process.exit(1)
    }
  }

  if (password !== null && (!password || password.length < 8)) {
    process.stderr.write('Das Passwort muss mindestens 8 Zeichen haben.\n')
    process.exit(1)
  }

  const hash = password === null ? null : await hashPassword(password)
  await store.update((c) => {
    if (hash) c.passwordHash = hash
    if (newUsername) c.username = newUsername
    // Any change here ends existing sessions; see auth/middleware.js.
    c.credentialsChangedAt = Math.floor(Date.now() / 1000)
    // Bootstrap a secret too, so a fresh config is immediately usable.
    if (!c.jwtSecret) c.jwtSecret = generateSecret()
    return c
  })
  await store.flush()

  if (generated) {
    process.stdout.write(`\n  Neues Passwort: ${password}\n\n`)
  }
  const what = [newUsername ? 'Benutzername' : null, hash ? 'Passwort' : null]
    .filter(Boolean)
    .join(' und ')
  process.stdout.write(`${what} für '${store.data.username}' gesetzt (${configFile}).\n`)
  process.stdout.write('Angemeldete Sitzungen wurden beendet.\n')
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
