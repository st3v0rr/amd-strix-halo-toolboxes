/**
 * The network page's firewall routes end to end: a real context and app on a
 * random port, firewall-cmd replaced by dev/bin/firewall-cmd with a state file
 * of its own, podman by dev/bin/podman.
 *
 * The point: the media API's port 8100 is managed like the RPC port — listed
 * with nothing running, opened, closed and let through for one
 * source — while a port no managed service claims stays untouchable.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shx-network-routes-'))
const firewallState = path.join(root, 'firewalld.json')
fs.writeFileSync(
  firewallState,
  JSON.stringify({ zone: 'public', runtime: ['8420/tcp'], permanent: ['8420/tcp'], runtimeRules: [], permanentRules: [] }),
)
Object.assign(process.env, {
  SHX_CONFIG_DIR: path.join(root, 'config'),
  SHX_STATE_DIR: path.join(root, 'state'),
  SHX_MOCK: '1',
  SHX_PODMAN_BIN: 'dev/bin/podman',
  SHX_MOCK_STATE: path.join(root, 'podman-state.json'),
  SHX_FIREWALL_CMD_BIN: 'dev/bin/firewall-cmd',
  SHX_MOCK_FIREWALL: 'running',
  SHX_MOCK_FIREWALL_STATE: firewallState,
  SHX_LOG_LEVEL: 'error',
})

const { createContext } = await import('../src/context.js')
const { createApp } = await import('../src/app.js')
const { signToken } = await import('../src/auth/tokens.js')
const { generateApiToken, hashApiToken } = await import('../src/auth/apitoken.js')
const { loopbackUrl } = await import('../src/mcp/routes.js')

const MEDIA_RULE = 'rule family="ipv4" source address="10.7.7.0/24" port port="8100" protocol="tcp" accept'

let ctx
let server
let base
let session
let token

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function call(method, p, { body, auth = 'session' } = {}) {
  const headers = { Accept: 'application/json' }
  if (auth === 'session') headers.Cookie = `shx_token=${session}`
  if (auth === 'token') headers.Authorization = `Bearer ${token}`
  if (method !== 'GET') {
    headers['X-Requested-With'] = 'shx'
    headers.Origin = base
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

const api = (method, p, opts) => call(method, `/api${p}`, opts)
const firewall = () => JSON.parse(fs.readFileSync(firewallState, 'utf8'))
const portEntry = async (port) => (await api('GET', '/network')).body.ports.find((p) => p.port === port)

before(async () => {
  ctx = createContext()
  token = generateApiToken()
  await ctx.config.update((c) => {
    c.jwtSecret = Buffer.alloc(32, 9).toString('base64')
    c.apiToken = { hash: hashApiToken(token), hint: 'x', createdAt: new Date().toISOString() }
    c.settings.mediaModelsDir = path.join(root, 'media-models')
    return c
  })
  await ctx.media.update((m) => ({ ...m, dataDir: path.join(root, 'media-data'), backend: 'mock' }))
  session = await signToken(ctx.config.data.jwtSecret, { sub: 'admin' })
  const app = createApp(ctx)
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  ctx.selfUrl = loopbackUrl(server.address())
  base = ctx.selfUrl
})

after(async () => {
  server?.closeAllConnections?.()
  await new Promise((resolve) => server?.close(resolve))
  await Promise.all([ctx.config.flush(), ctx.state.flush(), ctx.media.flush(), ctx.profiles.flush()])
})

test('the media API port is listed and managed with nothing running, beside the other standard ports', async () => {
  const { status, body } = await api('GET', '/network')
  assert.equal(status, 200, JSON.stringify(body))
  const media = body.ports.find((p) => p.port === 8100)
  assert.equal(media.kind, 'media')
  assert.equal(media.purpose, 'Media API (Standardport)')
  assert.equal(media.running, false)
  assert.equal(media.open, false)
  assert.match(media.detail, /API-Schlüssel/)
  for (const port of [8420, 50052]) assert.ok(body.ports.some((p) => p.port === port), String(port))
  // ComfyUI's former 8000 is no standard port any more.
  assert.equal(body.ports.some((p) => p.port === 8000), false)
  const ports = body.ports.map((p) => p.port)
  assert.deepEqual(ports, [...ports].sort((a, b) => a - b), 'ascending, as the page reads them')
  assert.equal(body.others.includes('8100/tcp'), false)
})

test('8100 opens and closes in the running and the permanent firewall', async () => {
  const opened = await api('POST', '/network/firewall/ports', { body: { port: 8100 } })
  assert.equal(opened.status, 200, JSON.stringify(opened.body))
  assert.deepEqual(opened.body, { spec: '8100/tcp', zone: 'public', permanent: true })
  assert.ok(firewall().runtime.includes('8100/tcp') && firewall().permanent.includes('8100/tcp'))
  assert.equal((await portEntry(8100)).open, true)

  const closed = await api('DELETE', '/network/firewall/ports?port=8100&protocol=tcp')
  assert.equal(closed.status, 200, JSON.stringify(closed.body))
  assert.ok(!firewall().runtime.includes('8100/tcp') && !firewall().permanent.includes('8100/tcp'))
  assert.equal((await portEntry(8100)).open, false)
})

test('8100 can be let through for one source network, shown with its port, and removed again', async () => {
  const added = await api('POST', '/network/firewall/rules', { body: { port: 8100, source: '10.7.7.0/24' } })
  assert.equal(added.status, 200, JSON.stringify(added.body))
  assert.equal(added.body.rule, MEDIA_RULE)
  assert.deepEqual(firewall().permanentRules, [MEDIA_RULE])

  const media = await portEntry(8100)
  assert.equal(media.open, false, 'still closed to everyone else')
  assert.deepEqual(media.sources, [{ source: '10.7.7.0/24', raw: MEDIA_RULE }])
  const { body } = await api('GET', '/network')
  assert.equal(body.otherRules.includes(MEDIA_RULE), false, 'a managed rule, not a stray')

  const removed = await api('DELETE', `/network/firewall/rules?rule=${encodeURIComponent(MEDIA_RULE)}`)
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  assert.deepEqual(firewall().runtimeRules, [])
  assert.deepEqual(firewall().permanentRules, [])
})

test('a port no managed service claims stays untouchable', async () => {
  const open = await api('POST', '/network/firewall/ports', { body: { port: 9999 } })
  assert.equal(open.status, 409)
  assert.match(open.body.error.message, /keinem verwalteten Dienst/)
  const close = await api('DELETE', '/network/firewall/ports?port=9999&protocol=tcp')
  assert.equal(close.status, 409)
  assert.match(close.body.error.message, /keinem verwalteten Dienst/)
  const rule = await api('POST', '/network/firewall/rules', { body: { port: 9999, source: '10.7.7.0/24' } })
  assert.equal(rule.status, 409)
})

test('an agent manages 8100 through the same routes', async () => {
  const rpc = (id, name, args) =>
    call('POST', '/mcp', {
      auth: 'token',
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    })
  const opened = await rpc(1, 'open_firewall_port', { port: 8100 })
  assert.equal(opened.body.result.isError, false, JSON.stringify(opened.body))
  assert.ok(firewall().runtime.includes('8100/tcp'))
  const closed = await rpc(2, 'close_firewall_port', { port: 8100 })
  assert.equal(closed.body.result.isError, false, JSON.stringify(closed.body))
  assert.ok(!firewall().runtime.includes('8100/tcp'))
  const refused = await rpc(3, 'close_firewall_port', { port: 9999 })
  assert.equal(refused.body.result.isError, true)
  const refusedOpen = await rpc(4, 'open_firewall_port', { port: 9999 })
  assert.equal(refusedOpen.body.result.isError, true)
  assert.match(refusedOpen.body.result.content[0].text, /keinem verwalteten Dienst/)
})

test('a media container on another port is managed there too, and says when a rule cannot help', async () => {
  const port = await freePort()
  const created = await api('POST', '/servers', { body: { role: 'media', port } })
  assert.equal(created.status, 201, JSON.stringify(created.body))

  let entry = await portEntry(port)
  assert.equal(entry.kind, 'media')
  assert.equal(entry.purpose, "Media API 'media-api'")
  assert.equal(entry.loopbackOnly, true, 'published on 127.0.0.1 only')
  assert.match(entry.detail, /bewirkt nichts/)
  assert.ok(await portEntry(8100), 'the standard port stays listed')

  assert.equal((await api('DELETE', '/servers/media-api')).status, 200)
  const exposed = await api('POST', '/servers', { body: { role: 'media', port, bindAddress: '0.0.0.0' } })
  assert.equal(exposed.status, 201, JSON.stringify(exposed.body))
  entry = await portEntry(port)
  assert.equal(entry.loopbackOnly, false)
  assert.match(entry.detail, /API-Schlüssel/)

  const restricted = await api('POST', '/network/firewall/rules', { body: { port, source: '192.168.1.0/24' } })
  assert.equal(restricted.status, 200, JSON.stringify(restricted.body))
  assert.deepEqual((await portEntry(port)).sources.map((s) => s.source), ['192.168.1.0/24'])
})
