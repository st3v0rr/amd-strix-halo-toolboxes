import assert from 'node:assert/strict'
import { test } from 'node:test'

import { JobManager } from '../src/lib/jobs.js'

/** A job that only finishes when the test says so. */
function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('a job is persisted as soon as it starts, not only when it ends', async () => {
  const snapshots = []
  const jobs = new JobManager({ persist: (snapshot) => snapshots.push(snapshot) })
  const gate = deferred()

  const job = jobs.start({ type: 'model-download', title: 'repo/x', meta: { repo: 'repo/x' } }, () => gate.promise)

  // This is what makes resuming possible at all: the process can die at any
  // moment, and only what reached `state.json` can be offered again afterwards.
  const running = snapshots.at(-1)
  assert.equal(running.length, 1)
  assert.equal(running[0].id, job.id)
  assert.equal(running[0].status, 'running')
  assert.deepEqual(running[0].meta, { repo: 'repo/x' })

  gate.resolve({ ok: true })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(snapshots.at(-1)[0].status, 'done')
})

test('a job that was running when the process died comes back as interrupted', () => {
  const jobs = new JobManager()
  jobs.restore([
    {
      id: 'a',
      type: 'model-download',
      title: 'repo/x',
      status: 'running',
      meta: { repo: 'repo/x', include: ['m.gguf'] },
      progress: { pct: 40, done: 4, total: 10, rate: null, eta: null },
    },
    { id: 'b', type: 'model-download', title: 'repo/y', status: 'done' },
  ])

  const [x] = jobs.list({ status: 'interrupted' })
  assert.equal(x.id, 'a')
  // The meta is the whole point: it is what the resume endpoint replays.
  assert.deepEqual(x.meta, { repo: 'repo/x', include: ['m.gguf'] })
  assert.equal(jobs.get('b').status, 'done')
})

test('cancelling a finished job dismisses it and announces the removal', () => {
  const jobs = new JobManager()
  jobs.restore([{ id: 'a', type: 'model-download', title: 'repo/x', status: 'failed' }])

  const removed = []
  jobs.on('job:removed', (id) => removed.push(id))

  assert.deepEqual(jobs.cancel('a'), { dismissed: true })
  assert.deepEqual(removed, ['a'])
  assert.equal(jobs.list().length, 0)
})

test('a queued job is cancelled without ever being run', async () => {
  const jobs = new JobManager()
  jobs.configureLane('model-download', 1)
  const gate = deferred()
  let secondRan = false

  jobs.start({ type: 'model-download', title: 'first' }, () => gate.promise)
  const queued = jobs.start({ type: 'model-download', title: 'second' }, async () => {
    secondRan = true
  })
  assert.equal(queued.status, 'queued')

  jobs.cancel(queued.id)
  gate.resolve(null)
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(secondRan, false)
  assert.equal(jobs.get(queued.id).status, 'cancelled')
})
