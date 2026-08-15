import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  formatRichRule,
  isManageablePort,
  parseRichRule,
  parseRichRules,
  parseSource,
} from '../../shared/firewall.js'

/** The rule shape this app models, exactly as firewalld prints it. */
const RPC_RULE =
  'rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" accept'

/* -------------------------------- sources -------------------------------- */

test('an address and a network are both accepted', () => {
  assert.deepEqual(parseSource('10.7.7.12'), {
    address: '10.7.7.12',
    prefix: null,
    cidr: '10.7.7.12',
  })
  assert.deepEqual(parseSource('10.7.7.0/24'), {
    address: '10.7.7.0',
    prefix: 24,
    cidr: '10.7.7.0/24',
  })
})

test('anything that could smuggle a second clause into the rule is refused', () => {
  // The parsed value is interpolated into a string firewalld parses itself, so
  // a quote or a space getting through here would be a rule of somebody else's
  // choosing.
  for (const bad of [
    '10.7.7.0/24" accept log',
    '10.7.7.0/24 accept',
    '10.7.7.0/24;reject',
    '"10.7.7.0"',
    '10.7.7.0/24/8',
    '',
    '   ',
  ]) {
    assert.equal(parseSource(bad), null, `${bad} muss abgelehnt werden`)
  }
})

test('a malformed address is refused', () => {
  for (const bad of ['10.7.7', '10.7.7.256', '10.7.7.01', '10.7.7.0/33', 'fe80::1', 'box.local']) {
    assert.equal(parseSource(bad), null, `${bad} muss abgelehnt werden`)
  }
})

/* -------------------------------- building -------------------------------- */

test('the built rule is byte-identical to the one firewalld prints', () => {
  // This is what makes a rule created here indistinguishable from one added by
  // hand — and what lets the same rule be found again for removal.
  assert.equal(formatRichRule({ port: 50052, protocol: 'tcp', source: '10.7.7.0/24' }), RPC_RULE)
})

test('tcp is the default protocol', () => {
  assert.equal(formatRichRule({ port: 50052, source: '10.7.7.0/24' }), RPC_RULE)
})

test('a rule is never built from input that would not survive validation', () => {
  assert.equal(formatRichRule({ port: 50052, source: 'nonsense' }), null)
  assert.equal(formatRichRule({ port: 22, source: '10.7.7.0/24' }), null)
  assert.equal(formatRichRule({ port: 50052, protocol: 'icmp', source: '10.7.7.0/24' }), null)
})

test('ports below 1024 are never manageable', () => {
  assert.equal(isManageablePort(22), false)
  assert.equal(isManageablePort(1023), false)
  assert.equal(isManageablePort(1024), true)
  assert.equal(isManageablePort(50052), true)
  assert.equal(isManageablePort(65536), false)
})

/* -------------------------------- parsing --------------------------------- */

test('the rule from a real zone is read back in full', () => {
  assert.deepEqual(parseRichRule(RPC_RULE), {
    raw: RPC_RULE,
    family: 'ipv4',
    source: '10.7.7.0/24',
    port: 50052,
    protocol: 'tcp',
    action: 'accept',
  })
})

test('a rule that does more than accept a port is not claimed', () => {
  // Logging, rate limits, rejects, services: all legitimate, none of them
  // something this app can put back together, so it must not offer to.
  for (const rule of [
    'rule family="ipv4" source address="10.7.7.0/24" service name="cockpit" accept',
    'rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" log prefix="rpc" level="info" accept',
    'rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" reject',
    'rule family="ipv4" source address="10.7.7.0/24" forward-port port="8080" protocol="tcp" to-port="80"',
    'rule family="ipv6" source address="2001:db8::/64" port port="50052" protocol="tcp" accept',
    'rule service name="ssh" accept',
    '',
  ]) {
    assert.equal(parseRichRule(rule), null, `${rule} darf nicht übernommen werden`)
  }
})

test('a whole listing keeps the unmodelled rules as raw text', () => {
  const listing = [
    RPC_RULE,
    'rule family="ipv4" source address="10.7.7.0/24" service name="cockpit" accept',
  ].join('\n')

  const parsed = parseRichRules(listing)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].parsed.port, 50052)
  assert.equal(parsed[1].parsed, null)
  assert.match(parsed[1].raw, /cockpit/)
})

test('an empty listing is an empty list', () => {
  assert.deepEqual(parseRichRules(''), [])
  assert.deepEqual(parseRichRules('\n\n'), [])
})

test('what is built can be read back', () => {
  // The round trip is the contract: the UI creates a rule, firewalld prints it,
  // and the same rule has to be recognisable for removal.
  const rule = formatRichRule({ port: 11434, source: '192.168.100.12' })
  const parsed = parseRichRule(rule)
  assert.equal(parsed.port, 11434)
  assert.equal(parsed.source, '192.168.100.12')
})
