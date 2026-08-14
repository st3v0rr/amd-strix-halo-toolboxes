/**
 * Parsing and formatting for llama.cpp RPC peers.
 *
 * Shared by the server (which validates a start request and builds the
 * `--rpc` argument) and the web client (which validates while you type), so
 * both sides agree on what "192.168.100.11" means. Free of Node built-ins and
 * browser globals, like everything else under shared/.
 */

import { RPC_PORT } from './constants.js'

/**
 * A DNS label as RFC 1123 allows it: alphanumeric at both ends, hyphens
 * inside. Covers plain IPv4 too, since digits are alphanumeric — the numeric
 * range check below is what actually rejects a malformed address.
 */
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

/**
 * Anything made only of digits and dots is held to IPv4 rules.
 *
 * Not just four-part addresses: `192.168.100` is a syntactically legal DNS
 * name, but it is never anything other than a typo'd IP, and a hostname whose
 * last label is all digits is invalid per RFC 1123 anyway. Catching it here
 * turns a mysterious "connection refused" into an error at the input field.
 */
const NUMERIC_HOST_RE = /^[\d.]+$/

/**
 * Split a peer into host and port.
 *
 * Accepts `host`, `host:port` and `ip`/`ip:port`; a missing port defaults to
 * RPC_PORT so you can paste a plain list of IPs. Returns null for anything we
 * would not be able to hand to podman verbatim.
 *
 * IPv6 is deliberately unsupported rather than half-supported: bracket syntax
 * would have to survive the label round-trip and the `--rpc` comma list, and
 * nobody is running a Strix Halo cluster on IPv6 link-local addresses. It is
 * rejected with a reason instead of being silently mangled.
 *
 * @param {string} input
 * @returns {{host: string, port: number} | null}
 */
export function parseRpcPeer(input) {
  const text = String(input ?? '').trim()
  if (!text) return null
  // An IPv6 address or a bracketed host — say no clearly rather than parsing
  // "::1" into host ":" port "1".
  if (text.includes('[') || (text.match(/:/g) ?? []).length > 1) return null

  const [host, portText] = text.split(':')
  if (!HOST_RE.test(host)) return null
  if (NUMERIC_HOST_RE.test(host)) {
    const octets = host.split('.')
    if (octets.length !== 4 || !octets.every(isIpv4Octet)) return null
  }

  if (portText === undefined) return { host, port: RPC_PORT }
  if (!/^\d{1,5}$/.test(portText)) return null
  const port = Number(portText)
  if (port < 1 || port > 65535) return null
  return { host, port }
}

function isIpv4Octet(part) {
  // Reject "01" and "1.2.3.04": a leading zero means a different number to
  // some resolvers (octal) and the same to others. Ambiguity is not worth it.
  if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) return false
  return Number(part) <= 255
}

/** The canonical `host:port` spelling, always with an explicit port. */
export function formatRpcPeer(peer) {
  return `${peer.host}:${peer.port}`
}

/**
 * Normalise a user-supplied list of peers.
 *
 * Input may be an array or one string with peers separated by commas,
 * whitespace or newlines — a textarea, in other words. Duplicates collapse
 * (the same GPU offered twice would be counted twice by llama.cpp and then
 * fight itself for memory), and order is preserved because it decides how
 * layers are distributed.
 *
 * @param {string|string[]} input
 * @returns {{peers: string[], invalid: string[]}}
 */
export function normalizeRpcPeers(input) {
  const tokens = (Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/))
    .map((t) => String(t).trim())
    .filter(Boolean)

  const peers = []
  const invalid = []
  const seen = new Set()

  for (const token of tokens) {
    const parsed = parseRpcPeer(token)
    if (!parsed) {
      invalid.push(token)
      continue
    }
    const formatted = formatRpcPeer(parsed)
    if (seen.has(formatted)) continue
    seen.add(formatted)
    peers.push(formatted)
  }

  return { peers, invalid }
}

/** The value of llama-server's `--rpc` flag. */
export function rpcArgument(peers) {
  return peers.join(',')
}
