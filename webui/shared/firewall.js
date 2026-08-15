/**
 * The one shape of firewalld rich rule this app deals in:
 *
 *   rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" accept
 *
 * That is a port opened for one source network instead of for everyone, which
 * is exactly what the RPC port needs — `ggml-rpc-server` has no authentication
 * of its own, so the firewall is the only thing standing between it and the
 * network.
 *
 * Everything else firewalld can express (services, logging, rejects,
 * forwarding, ipsets) is deliberately not modelled. Such rules are read back as
 * unparsed text and shown as-is; the app neither edits nor removes what it
 * cannot fully describe.
 *
 * Shared by the server, which builds and validates the rule, and by the web
 * client, which validates while you type and previews the exact rule string.
 * Free of Node built-ins and browser globals, like everything under shared/.
 */

/** Ports below this are never touched from the web interface — 22 among them. */
import { PORT_MAX, PORT_MIN } from './constants.js'

/**
 * Parse a source address: an IPv4 address, optionally with a prefix length.
 *
 * Strict on purpose. The result is interpolated into a rule string that
 * firewalld parses itself, so anything that could carry a quote, a space or a
 * second clause has to be rejected here rather than escaped later.
 *
 * @param {string} input
 * @returns {{address: string, prefix: number|null, cidr: string} | null}
 */
export function parseSource(input) {
  const text = String(input ?? '').trim()
  if (!text) return null

  const [address, prefixText, ...rest] = text.split('/')
  if (rest.length) return null

  const octets = address.split('.')
  if (octets.length !== 4 || !octets.every(isIpv4Octet)) return null

  if (prefixText === undefined) return { address, prefix: null, cidr: address }
  if (!/^\d{1,2}$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  if (prefix > 32) return null

  return { address, prefix, cidr: `${address}/${prefix}` }
}

function isIpv4Octet(part) {
  // Same rule as the RPC peer parser: a leading zero is octal to some parsers
  // and decimal to others, and that ambiguity has no place in a firewall rule.
  if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) return false
  return Number(part) <= 255
}

/** Whether a port may be managed from the web interface at all. */
export function isManageablePort(port) {
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX
}

/**
 * Build the rule string. Field order matches what firewalld itself prints, so
 * a rule this app created reads back identically to one added by hand.
 *
 * @param {{port: number, protocol?: string, source: string}} spec
 * @returns {string|null} null when the input would not survive validation
 */
export function formatRichRule({ port, protocol = 'tcp', source }) {
  const parsedSource = parseSource(source)
  if (!parsedSource) return null
  if (!isManageablePort(Number(port))) return null
  if (!['tcp', 'udp'].includes(protocol)) return null

  return (
    `rule family="ipv4" source address="${parsedSource.cidr}" ` +
    `port port="${port}" protocol="${protocol}" accept`
  )
}

/**
 * Read one rule back.
 *
 * @param {string} raw a line of `firewall-cmd --list-rich-rules`
 * @returns {{raw: string, family: string, source: string, port: number,
 *   protocol: string, action: string} | null} null for every rule shape this
 *   app does not model
 */
export function parseRichRule(raw) {
  const text = String(raw ?? '').trim()
  if (!text.startsWith('rule ')) return null

  const family = /\bfamily="([^"]+)"/.exec(text)?.[1] ?? null
  const source = /\bsource address="([^"]+)"/.exec(text)?.[1] ?? null
  const port = /\bport port="(\d{1,5})"/.exec(text)?.[1] ?? null
  const protocol = /\bprotocol="([a-z]+)"/.exec(text)?.[1] ?? null
  if (family !== 'ipv4' || !source || !port || !protocol) return null

  // Only a plain accept. A rule that also logs, rate-limits or rejects is more
  // than this app can put back together, so it stays untouched.
  if (!/\baccept$/.test(text)) return null
  if (/\b(log|audit|mark|limit|reject|drop|service |forward-port|masquerade)\b/.test(text)) {
    return null
  }
  if (!parseSource(source)) return null

  return { raw: text, family, source, port: Number(port), protocol, action: 'accept' }
}

/** Parse a whole `--list-rich-rules` output, dropping what we do not model. */
export function parseRichRules(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ raw: line, parsed: parseRichRule(line) }))
}
