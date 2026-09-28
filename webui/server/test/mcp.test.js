import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  apiTokenHint,
  bearerFrom,
  generateApiToken,
  hashApiToken,
  verifyApiToken,
} from '../src/auth/apitoken.js'
import { originGuard, requireAuth, requireSession } from '../src/auth/middleware.js'
import { PROTOCOL_VERSIONS, RPC, ToolError, createMcpHandler } from '../src/mcp/protocol.js'
import { loopbackUrl } from '../src/mcp/routes.js'
import { tools } from '../src/mcp/tools.js'

/* -------------------------------- API token -------------------------------- */

test('an API token verifies against its hash and nothing else does', () => {
  const token = generateApiToken()
  const hash = hashApiToken(token)
  assert.match(token, /^shx_[A-Za-z0-9_-]{43}$/)
  assert.equal(verifyApiToken(token, hash), true)
  assert.equal(verifyApiToken(generateApiToken(), hash), false)
  assert.equal(verifyApiToken(token, null), false)
  assert.equal(verifyApiToken(token, 'short'), false)
  assert.equal(verifyApiToken(hash, hash), false, 'the hash itself is not a token')
  assert.equal(verifyApiToken(undefined, hash), false)
})

test('the token hint gives away too little to use', () => {
  const token = generateApiToken()
  const hint = apiTokenHint(token)
  assert.ok(hint.startsWith('shx_'))
  assert.ok(hint.length < 16)
})

function fakeReq({ method = 'GET', headers = {}, cookies = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { method, cookies, query: {}, get: (name) => lower[name.toLowerCase()] }
}

test('bearerFrom reads only a well-formed Bearer header', () => {
  assert.equal(bearerFrom(fakeReq({ headers: { authorization: 'Bearer abc' } })), 'abc')
  assert.equal(bearerFrom(fakeReq({ headers: { authorization: 'bearer abc ' } })), 'abc')
  assert.equal(bearerFrom(fakeReq({ headers: { authorization: 'Basic abc' } })), null)
  assert.equal(bearerFrom(fakeReq({ headers: { authorization: 'Bearer a b' } })), null)
  assert.equal(bearerFrom(fakeReq()), null)
})

function run(mw, req) {
  return new Promise((resolve) => {
    const res = { cookie() {}, clearCookie() {} }
    Promise.resolve(mw(req, res, (err) => resolve(err ?? null)))
  })
}

test('requireAuth accepts the API token and marks the request as token-borne', async () => {
  const token = generateApiToken()
  const config = { username: 'admin', jwtSecret: 'x', apiToken: { hash: hashApiToken(token) } }
  const req = fakeReq({ headers: { authorization: `Bearer ${token}` } })
  assert.equal(await run(requireAuth(() => config), req), null)
  assert.deepEqual(req.user, { username: 'admin', via: 'token' })
})

test('requireAuth rejects a wrong or revoked token', async () => {
  const token = generateApiToken()
  const config = { username: 'admin', jwtSecret: 'x', apiToken: { hash: hashApiToken(token) } }
  const wrong = fakeReq({ headers: { authorization: `Bearer ${generateApiToken()}` } })
  assert.equal((await run(requireAuth(() => config), wrong))?.status, 401)

  const revoked = fakeReq({ headers: { authorization: `Bearer ${token}` } })
  assert.equal((await run(requireAuth(() => ({ ...config, apiToken: null })), revoked))?.status, 401)
})

test('originGuard lets a bearer request through without CSRF headers', async () => {
  const req = fakeReq({ method: 'POST', headers: { authorization: 'Bearer shx_x' } })
  assert.equal(await run(originGuard, req), null)
})

test('requireSession keeps token holders away from credentials', async () => {
  assert.equal((await run(requireSession, { user: { via: 'token' } }))?.status, 403)
  assert.equal(await run(requireSession, { user: { via: 'session' } }), null)
})

/* --------------------------------- protocol --------------------------------- */

const echo = {
  name: 'echo',
  description: 'returns its input',
  inputSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
  run: async (args) => ({ said: args.word }),
}
const failing = {
  name: 'fail',
  description: 'the API says no',
  inputSchema: { type: 'object', properties: {} },
  run: async () => {
    throw new ToolError('Modell wird benutzt.', {
      status: 409,
      code: 'conflict',
      details: { servers: ['qwen'] },
    })
  },
}
const handler = createMcpHandler({
  tools: [echo, failing],
  serverInfo: { name: 't', version: '0' },
  instructions: 'hi',
})

test('initialize echoes a supported protocol version and offers tools', async () => {
  const reply = await handler({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
  })
  assert.equal(reply.id, 1)
  assert.equal(reply.result.protocolVersion, '2025-03-26')
  assert.deepEqual(reply.result.capabilities, { tools: { listChanged: false } })
  assert.equal(reply.result.instructions, 'hi')
})

test('initialize answers an unknown version with the newest one', async () => {
  const reply = await handler({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  })
  assert.equal(reply.result.protocolVersion, PROTOCOL_VERSIONS[0])
})

test('notifications get no answer, unknown methods a JSON-RPC error', async () => {
  assert.equal(await handler({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  const reply = await handler({ jsonrpc: '2.0', id: 'x', method: 'resources/list' })
  assert.equal(reply.error.code, RPC.methodNotFound)
  assert.equal((await handler('nope')).error.code, RPC.invalidRequest)
})

test('tools/call returns the result as text', async () => {
  const reply = await handler({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'echo', arguments: { word: 'hallo' } },
  })
  assert.equal(reply.result.isError, false)
  assert.deepEqual(JSON.parse(reply.result.content[0].text), { said: 'hallo' })
})

test('an API refusal becomes a tool error the model can read, details included', async () => {
  const reply = await handler({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fail' } })
  assert.equal(reply.result.isError, true)
  assert.match(reply.result.content[0].text, /409 \(conflict\): Modell wird benutzt\./)
  assert.match(reply.result.content[0].text, /qwen/)
})

test('a missing required argument is named rather than sent on', async () => {
  const reply = await handler({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'echo', arguments: {} },
  })
  assert.equal(reply.result.isError, true)
  assert.match(reply.result.content[0].text, /word/)
})

test('an unknown tool is a protocol error', async () => {
  const reply = await handler({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x' } })
  assert.equal(reply.error.code, RPC.invalidParams)
})

/* ---------------------------------- tools ---------------------------------- */

test('tool names are unique and fit the MCP naming rules', () => {
  const names = tools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length)
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/, tool.name)
    assert.equal(tool.inputSchema.type, 'object', tool.name)
    for (const key of tool.inputSchema.required ?? []) {
      assert.ok(key in tool.inputSchema.properties, `${tool.name}: required ${key} is not a property`)
    }
    assert.ok(tool.annotations, `${tool.name} has no annotations`)
  }
})

test('no MCP tool can read or change the media API secrets', () => {
  // Rotating or choosing the key is a browser-session action; an agent must not
  // be able to lock the owner's clients out or learn a key it was not shown.
  for (const tool of tools) {
    assert.ok(!String(tool.run).includes('/media/secrets'), `${tool.name} touches the media secrets`)
  }
  const names = tools.map((t) => t.name)
  for (const name of ['get_media_api', 'configure_media_api', 'create_media_api', 'list_media_models', 'fetch_media_models', 'resume_media_fetch']) {
    assert.ok(names.includes(name), name)
  }
})

/** A fake REST API that records calls and answers from a table. */
function fakeApi(routes) {
  const calls = []
  const api = async (method, path, opts = {}) => {
    calls.push({ method, path, ...opts })
    const answer = routes[`${method} ${path}`]
    if (answer === undefined) throw new ToolError(`no route ${method} ${path}`, { status: 404 })
    return typeof answer === 'function' ? answer(opts) : answer
  }
  return { api, calls }
}

const tool = (name) => tools.find((t) => t.name === name)

const SETTINGS = {
  settings: { defaultImage: 'img:vulkan', defaultCtxSize: 65536, defaultGpuLayers: 999, defaultThreads: 12 },
}

test('create_llama_server fills the gaps from the settings, but not over explicit values', async () => {
  const { api, calls } = fakeApi({ 'GET /settings': SETTINGS, 'POST /servers': { name: 'q' } })
  await tool('create_llama_server').run({ name: 'q', modelPath: 'm.gguf', port: 8080, ctxSize: 8192 }, api)
  assert.deepEqual(calls.at(-1).body, {
    image: 'img:vulkan',
    ctxSize: 8192,
    gpuLayers: 999,
    threads: 12,
    name: 'q',
    modelPath: 'm.gguf',
    port: 8080,
    replace: false,
  })
})

const PROFILE = {
  id: 'p1',
  name: 'qwen',
  image: 'img',
  modelPath: 'a.gguf',
  port: 8080,
  ctxSize: 4096,
  gpuLayers: 999,
  threads: 12,
  apiKey: 'k',
  autostart: false,
  createdAt: 'c',
  updatedAt: 'u',
}

test('update_profile finds a profile by name and sends the merged whole', async () => {
  const { api, calls } = fakeApi({
    'GET /profiles': { profiles: [PROFILE] },
    'PUT /profiles/p1': (o) => ({ profile: o.body }),
  })
  await tool('update_profile').run({ profile: 'qwen', ctxSize: 32768 }, api)
  const put = calls.at(-1)
  assert.equal(put.path, '/profiles/p1')
  assert.equal(put.body.ctxSize, 32768)
  assert.equal(put.body.modelPath, 'a.gguf')
  assert.equal('id' in put.body || 'createdAt' in put.body, false)
})

test('an unknown profile says which ones exist', async () => {
  const { api } = fakeApi({ 'GET /profiles': { profiles: [PROFILE] } })
  await assert.rejects(tool('launch_profile').run({ profile: 'llama' }, api), /qwen/)
})

test('delete_model sends force only when asked — the API coerces "false" to true', async () => {
  const { api, calls } = fakeApi({ 'DELETE /models': {} })
  await tool('delete_model').run({ key: 'k' }, api)
  assert.equal(calls[0].query.force, undefined)
  await tool('delete_model').run({ key: 'k', force: true }, api)
  assert.equal(calls[1].query.force, true)
})

test('container names are escaped into the path', async () => {
  const { api, calls } = fakeApi({ 'POST /servers/a%2F..%2Fb/stop': {} })
  await tool('stop_server').run({ name: 'a/../b' }, api)
  assert.equal(calls[0].path, '/servers/a%2F..%2Fb/stop')
})

test('wait_for_job returns as soon as the job is finished', async () => {
  let polls = 0
  const { api } = fakeApi({
    'GET /jobs/j1': () => {
      polls += 1
      return {
        job: { id: 'j1', status: polls < 2 ? 'running' : 'done' },
        logs: [{ seq: 1, value: 'fertig' }],
      }
    },
  })
  const result = await tool('wait_for_job').run({ id: 'j1', timeoutSeconds: 10 }, api)
  assert.equal(result.finished, true)
  assert.deepEqual(result.logs, ['fertig'])
})

test('the overview leaves out the sparkline history', async () => {
  const { api } = fakeApi({
    'GET /system': { memory: 1, history: [1, 2, 3] },
    'GET /servers': { servers: [] },
    'GET /jobs': { jobs: [{ status: 'running' }, { status: 'done' }] },
  })
  const result = await tool('get_overview').run({}, api)
  assert.equal('history' in result.system, false)
  assert.equal(result.activeJobs.length, 1)
})

test('configure_media_api merges limits, create_media_api defaults to no replace', async () => {
  const { api, calls } = fakeApi({
    'GET /media': { config: { limits: { maxSteps: 60, maxQueuedJobs: null } } },
    'PUT /media/config': (o) => ({ config: o.body }),
    'POST /media/apply': (o) => o.body,
  })
  await tool('configure_media_api').run({ limits: { maxQueuedJobs: 4 } }, api)
  assert.deepEqual(calls.at(-1).body.limits, { maxSteps: 60, maxQueuedJobs: 4 })
  await tool('configure_media_api').run({ logLevel: 'debug' }, api)
  assert.deepEqual(calls.at(-1).body, { logLevel: 'debug' }, 'no extra GET without limits')
  await tool('create_media_api').run({}, api)
  assert.deepEqual(calls.at(-1).body, { replace: false })
})

/* -------------------------------- loopback -------------------------------- */

test('loopbackUrl turns a wildcard bind into loopback', () => {
  assert.equal(loopbackUrl({ address: '0.0.0.0', port: 8420, family: 'IPv4' }), 'http://127.0.0.1:8420')
  assert.equal(loopbackUrl({ address: '::', port: 8420, family: 'IPv6' }), 'http://[::1]:8420')
  assert.equal(loopbackUrl({ address: '10.0.0.5', port: 1, family: 'IPv4' }), 'http://10.0.0.5:1')
  assert.equal(loopbackUrl({ address: 'fe80::1', port: 1, family: 'IPv6' }), 'http://[fe80::1]:1')
})
