import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Recognisable in a config file or a leaked log line, like `hf_` or `ghp_`. */
const PREFIX = 'shx_'

/**
 * A bearer token for the MCP endpoint and any other non-browser client.
 *
 * 32 random bytes need no rate limiting and no slow hash: nobody guesses
 * 2^256. That is also why a plain SHA-256 is the right thing to store — scrypt
 * protects low-entropy passwords, and this is not one.
 */
export function generateApiToken() {
  return `${PREFIX}${randomBytes(32).toString('base64url')}`
}

export function hashApiToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * @param {string|undefined|null} token as presented by the client
 * @param {string|undefined|null} storedHash hex SHA-256 from the config
 */
export function verifyApiToken(token, storedHash) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return false
  if (typeof storedHash !== 'string' || storedHash.length !== 64) return false
  const actual = Buffer.from(hashApiToken(token), 'hex')
  const expected = Buffer.from(storedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Enough of the token to tell two apart in the UI, nothing more. */
export function apiTokenHint(token) {
  return `${token.slice(0, PREFIX.length + 4)}…${token.slice(-4)}`
}

/** The token from an `Authorization: Bearer …` header, or null. */
export function bearerFrom(req) {
  const header = req.get('authorization')
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : null
}
