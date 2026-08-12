import express from 'express'

import { repoRoot } from '../config/paths.js'
import { which } from '../lib/exec.js'
import { openSse } from '../lib/sse.js'
import { lastReconcile } from '../podman/autostart.js'
import { readBootParams, readKernel } from '../system/host.js'
import { monitor } from '../system/monitor.js'

export function systemRoutes(ctx) {
  const router = express.Router()

  router.get('/', async (req, res, next) => {
    try {
      const snapshot = await monitor.snapshot()
      res.json({ ...snapshot, autostart: lastReconcile() })
    } catch (err) {
      next(err)
    }
  })

  router.get('/events', (req, res) => {
    const sse = openSse(req, res)

    // Send the accumulated history first so sparklines are populated on the
    // very first frame rather than filling in over the next ten minutes.
    monitor
      .snapshot()
      .then((snapshot) => sse.send('snapshot', snapshot))
      .catch(() => {})

    const unsubscribe = monitor.subscribe((sample) => {
      sse.send('tick', { ...sample, containers: monitor.containerStats })
    })
    req.on('close', unsubscribe)
  })

  /**
   * Restart the service.
   *
   * Just exits: the unit carries `Restart=always`, so systemd brings us back
   * within seconds. Calling `systemctl restart` from inside the unit would
   * work too, but this needs no scope handling and no second binary — and it
   * cannot leave the service stopped if the call itself fails.
   *
   * Running containers are unaffected; they are separate processes. In-flight
   * download jobs do die, and are marked `interrupted` on the way back up.
   */
  router.post('/restart', (req, res) => {
    // systemd sets INVOCATION_ID. Without a supervisor, exiting would simply
    // take the app down for good.
    const supervised = Boolean(process.env.INVOCATION_ID)
    const running = ctx.jobs.list({ status: 'running' })

    if (!supervised) {
      return res.status(424).json({
        error: {
          code: 'not_supervised',
          message:
            'Der Dienst läuft nicht unter systemd — ein Neustart über die Oberfläche würde ihn beenden. Starte ihn von Hand neu.',
        },
      })
    }

    ctx.log.info(`Neustart über die Oberfläche angefordert (${running.length} laufende Jobs).`)
    res.json({ ok: true, interruptedJobs: running.map((j) => j.title) })

    // Let the response reach the browser before the process goes away.
    setTimeout(() => {
      Promise.allSettled([ctx.config.flush(), ctx.profiles.flush(), ctx.state.flush()]).then(() => {
        process.exit(0)
      })
    }, 250).unref?.()
  })

  router.get('/info', async (req, res, next) => {
    try {
      const [podman, python, hf, git] = await Promise.all([
        which('podman', ['--version']),
        which('python3', ['--version']),
        which('hf', ['--version']),
        which('git', ['--version']),
      ])
      res.json({
        kernel: await readKernel(),
        bootParams: await readBootParams(),
        repoRoot,
        modelsDir: ctx.settings.modelsDir,
        tools: { podman, python, hf, git },
        node: process.version,
      })
    } catch (err) {
      next(err)
    }
  })

  return router
}
