import { z } from 'zod'

import {
  IMAGE_REPO,
  MEDIA_PORT,
  MEDIA_TAGS,
  NAME_RE,
  PORT_MAX,
  PORT_MIN,
  ROLE,
  SERVER_DEFAULTS,
  SPEC_TYPES,
} from '../../../shared/constants.js'
import {
  MEDIA_BACKENDS,
  MEDIA_LIMITS,
  MEDIA_LOG_LEVELS,
  MEDIA_MEMORY_CHECKS,
  isIpv4,
  parseOrigin,
  parsePublicUrl,
} from '../../../shared/media.js'
import {
  defaultComfyModelsDir,
  defaultComfyOutputDir,
  defaultMediaDataDir,
  defaultModelsDir,
} from './paths.js'

const port = z.number().int().min(PORT_MIN).max(PORT_MAX)

export const settingsSchema = z.object({
  modelsDir: z.string().min(1).default(defaultModelsDir),
  /** ComfyUI keeps its own tree of .safetensors, quite separate from the GGUFs. */
  comfyModelsDir: z.string().min(1).default(defaultComfyModelsDir),
  comfyOutputDir: z.string().min(1).default(defaultComfyOutputDir),
  bindAddress: z.string().min(1).default('0.0.0.0'),
  port: port.default(8420),
  defaultImage: z.string().min(1).default(SERVER_DEFAULTS.image),
  defaultCtxSize: z.number().int().min(256).max(4_000_000).default(SERVER_DEFAULTS.ctxSize),
  defaultGpuLayers: z.number().int().min(0).max(9999).default(SERVER_DEFAULTS.gpuLayers),
  defaultThreads: z.number().int().min(1).max(512).default(SERVER_DEFAULTS.threads),
  maxConcurrentDownloads: z.number().int().min(1).max(3).default(1),
  allowCustomImages: z.boolean().default(false),
  imageCheckIntervalHours: z.number().int().min(1).max(168).default(6),
  useHfTransfer: z.boolean().default(false),
  /**
   * Force plain HTTP downloads instead of Xet. Authenticated Xet transfers
   * have been observed to stall outright on some networks — this is the
   * escape hatch that keeps the token usable for gated repos.
   */
  disableXet: z.boolean().default(false),
})

export const configSchema = z.object({
  version: z.literal(1).default(1),
  username: z.string().min(1).default('admin'),
  passwordHash: z.string().default(''),
  jwtSecret: z.string().default(''),
  hfToken: z.string().default(''),
  /**
   * When the credentials last changed, as epoch seconds. Tokens issued before
   * this are rejected — without it, changing a password because you suspect a
   * compromise would leave the attacker's session valid for up to 12 hours.
   */
  credentialsChangedAt: z.number().int().min(0).default(0),
  /**
   * The bearer token for MCP clients, stored as a SHA-256 hash. The plain
   * token is shown once when it is created and never again. Null: no token,
   * so the MCP endpoint answers every request with 401.
   */
  apiToken: z
    .object({ hash: z.string().length(64), hint: z.string(), createdAt: z.string() })
    .nullable()
    .default(null),
  settings: settingsSchema.default({}),
})

export const profileSchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(NAME_RE),
  image: z.string().min(1),
  modelPath: z.string().min(1),
  /** Vision projector for a multimodal model; '' means an ordinary text model. */
  mmprojPath: z.string().default(''),
  /** Speculative decoding; '' means off. A strategy always needs a draft model. */
  specType: z.enum(SPEC_TYPES).or(z.literal('')).default(''),
  specDraftModel: z.string().default(''),
  specDraftNMax: z.number().int().min(1).max(64).nullable().default(null),
  port,
  ctxSize: z.number().int().min(256).max(4_000_000),
  gpuLayers: z.number().int().min(0).max(9999),
  threads: z.number().int().min(1).max(512),
  apiKey: z.string().min(1),
  // Empty string means "autodetect from the image" — same semantics as the
  // script's empty EXTRA_ARGS.
  extraArgs: z.string().default(''),
  /**
   * `host:port` RPC workers this profile distributes over. Empty is the normal
   * single-machine case. Note that autostart plus peers is a gamble: the
   * workers have to be up first, and nothing here can guarantee that.
   */
  rpcPeers: z.array(z.string().min(1).max(300)).max(32).default([]),
  autostart: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const profilesSchema = z.object({
  version: z.literal(1).default(1),
  profiles: z.array(profileSchema).default([]),
})

export const stateSchema = z.object({
  version: z.literal(1).default(1),
  /** imageId -> detected llama-server extra args. Keyed by ID, not tag. */
  featureCache: z
    .record(z.object({ extraArgs: z.string(), detectedAt: z.string() }))
    .default({}),
  /** tag -> last known local/remote digests and check timestamps. */
  imageStatus: z
    .record(
      z.object({
        localDigest: z.string().nullable().default(null),
        remoteDigest: z.string().nullable().default(null),
        remoteCheckedAt: z.string().nullable().default(null),
        newestImmutableTag: z.string().nullable().default(null),
        newestBuildAt: z.string().nullable().default(null),
      }),
    )
    .default({}),
  /** Back-off deadline after a registry 429, as an ISO timestamp. */
  registryBackoffUntil: z.string().nullable().default(null),
  jobs: z.array(z.record(z.unknown())).default([]),
})

/**
 * The media API service, one per box: what its container is created from.
 *
 * A stored spec like a profile, not live state — the container carries what
 * it was actually started with in its labels, and a label hash tells the two
 * apart when this changes. Secrets are not in here at all: they are files of
 * their own (see media/secrets.js).
 */
export const mediaConfigSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().regex(NAME_RE).default('media-api'),
  image: z.string().min(1).max(400).default(`${IMAGE_REPO}:${MEDIA_TAGS[0]}`),
  port: port.default(MEDIA_PORT),
  /**
   * Host address the port is published on. Loopback by default: the service
   * speaks plain HTTP, so anything wider belongs behind a TLS reverse proxy.
   */
  bindAddress: z.string().refine(isIpv4, 'keine IPv4-Adresse').default('127.0.0.1'),
  /** Where a reverse proxy serves the service, for the playground link. '' = none. */
  publicUrl: z
    .string()
    .max(400)
    .refine((v) => v === '' || parsePublicUrl(v) !== null, 'keine http(s)-Adresse')
    .default(''),
  /** '' means the ComfyUI model tree, whose layout the service reads as-is. */
  modelsDir: z.string().max(1000).default(''),
  modelsReadOnly: z.boolean().default(true),
  dataDir: z.string().min(1).max(1000).default(defaultMediaDataDir),
  backend: z.enum(MEDIA_BACKENDS).default('real'),
  /** MEDIA_ALLOW_DOWNLOADS: a job may fetch what it lacks. Needs a writable model mount. */
  allowDownloads: z.boolean().default(false),
  memoryCheck: z.enum(MEDIA_MEMORY_CHECKS).default('strict'),
  memoryReserveGb: z.number().min(0).max(1024).default(8),
  disableMmap: z.boolean().default(true),
  logLevel: z.enum(MEDIA_LOG_LEVELS).default('info'),
  cookieSecure: z.boolean().default(false),
  allowXApiKey: z.boolean().default(true),
  corsOrigins: z
    .array(z.string().refine((v) => parseOrigin(v) !== null, 'keine http(s)-Origin'))
    .max(16)
    .default([]),
  sessionTtlHours: z.number().int().min(1).max(720).default(12),
  /** null: not passed, so the service's own default applies. */
  limits: z
    .object(
      Object.fromEntries(
        MEDIA_LIMITS.map((l) => [
          l.key,
          (l.int ? z.number().int() : z.number()).min(l.min).max(l.max).nullable().default(null),
        ]),
      ),
    )
    .default({}),
  autostart: z.boolean().default(false),
  updatedAt: z.string().nullable().default(null),
})

/**
 * The choices "Media API starten" on the Servers page offers, as POST /servers
 * takes them. Merged into the stored settings above: whatever is not named
 * keeps its stored value, so the dialog stays as small as ComfyUI's.
 */
export const mediaStartSchema = mediaConfigSchema
  .pick({ name: true, port: true, bindAddress: true, autostart: true })
  .partial()
  .extend({ role: z.literal(ROLE.media) })

/** Settings that may be changed through the API. */
export const settingsPatchSchema = settingsSchema.partial().extend({
  // Write-only: the API never hands the token back out.
  hfToken: z.string().optional(),
})

export { IMAGE_REPO }
