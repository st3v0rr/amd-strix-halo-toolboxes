import {
  configFile,
  ensureDirs,
  logFile,
  mediaConfigFile,
  mediaSecretsDir,
  profilesFile,
  stateFile,
} from './config/paths.js'
import { configSchema, mediaConfigSchema, profilesSchema, stateSchema } from './config/schema.js'
import { JsonStore } from './config/store.js'
import { JobManager } from './lib/jobs.js'
import { log } from './lib/log.js'
import { registerSecret } from './lib/redact.js'
import { createMediaSecrets } from './media/secrets.js'

/**
 * The application's shared state, assembled once at boot and passed to route
 * factories. Explicit wiring rather than module-level singletons, so the tests
 * can build an isolated instance against a temp directory.
 */
export function createContext() {
  ensureDirs()
  log.attachFile(logFile)

  const configStore = new JsonStore({
    file: configFile,
    schema: configSchema,
    mode: 0o600,
    log: (msg, err) => log.warn(msg, err),
  })
  const profilesStore = new JsonStore({
    file: profilesFile,
    schema: profilesSchema,
    mode: 0o600,
    log: (msg, err) => log.warn(msg, err),
  })
  const stateStore = new JsonStore({
    file: stateFile,
    schema: stateSchema,
    mode: 0o600,
    log: (msg, err) => log.warn(msg, err),
  })

  const mediaStore = new JsonStore({
    file: mediaConfigFile,
    schema: mediaConfigSchema,
    mode: 0o600,
    log: (msg, err) => log.warn(msg, err),
  })

  configStore.load()
  profilesStore.load()
  stateStore.load()
  mediaStore.load()

  const mediaSecrets = createMediaSecrets(mediaSecretsDir)
  // config.json is the durable source of truth for the global token. Repair a
  // mounted file left by a crash in an unacknowledged update before any route,
  // job or container operation can use it.
  mediaSecrets.refreshHfToken(configStore.data.hfToken || null)

  const jobs = new JobManager({
    persist: (snapshot) => {
      stateStore.update((s) => {
        s.jobs = snapshot
        return s
      })
    },
  })
  jobs.restore(stateStore.data.jobs)

  const ctx = {
    config: configStore,
    profiles: profilesStore,
    state: stateStore,
    /** The media API's settings; its secrets are files, handled by mediaSecrets. */
    media: mediaStore,
    mediaSecrets,
    jobs,
    log,
    /** Convenience accessors; the stores stay the source of truth. */
    get settings() {
      return configStore.data.settings
    },
    getConfig: () => configStore.data,
  }

  refreshSecrets(ctx)
  jobs.configureLane('model-download', ctx.settings.maxConcurrentDownloads)
  jobs.configureLane('image-pull', 1)
  jobs.configureLane('feature-detect', 2)
  jobs.configureLane('app-update', 1)
  // One media fetch at a time: they share the CLI's staging directory.
  jobs.configureLane('media-fetch', 1)

  return ctx
}

/**
 * Teach the redactor every secret we currently hold, so none of them can reach
 * a log line, an SSE frame or an error response.
 */
export function refreshSecrets(ctx) {
  registerSecret(ctx.config.data.hfToken)
  registerSecret(ctx.config.data.jwtSecret)
  for (const profile of ctx.profiles.data.profiles) registerSecret(profile.apiKey)
  // Reading them is registering them; a missing or unreadable file is the
  // media page's to report, not a reason to keep the app from starting.
  try {
    ctx.mediaSecrets.status()
  } catch (err) {
    ctx.log.warn(`Media-API-Geheimnisse nicht lesbar: ${err.message}`)
  }
}
