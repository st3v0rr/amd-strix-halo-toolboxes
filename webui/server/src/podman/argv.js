import {
  CONTAINER_MODELS_DIR,
  CONTAINER_PORT,
  EXTRA_ARGS_OLD,
  MEDIA_CONTAINER_DATA_DIR,
  MEDIA_CONTAINER_MODELS_DIR,
  MEDIA_PORT,
  MEDIA_SECRET_MOUNTS,
  RPC_PORT,
} from '../../../shared/constants.js'
import { MEDIA_LIMITS } from '../../../shared/media.js'
import { rpcArgument } from '../../../shared/rpc.js'

/**
 * Builds the `podman run` argv for a llama-server container.
 *
 * This is a faithful port of run-llama-server.sh lines 223-243 and the path
 * handling above it. The ordering and every flag matter: the parity harness in
 * dev/parity diffs our output against the argv the real script produces, so
 * changes here must keep that diff empty (or the script must change too).
 *
 * Pure function, no I/O — the existence check lives in servers.js so this stays
 * trivially testable.
 */

/**
 * The script accepts `models/foo.gguf`, `/foo.gguf` and `foo.gguf` alike:
 * `${MODEL_PATH#models/}` then `${...#/}`. Reproduce exactly that, including
 * the fact that it strips at most one of each, in that order.
 */
export function normalizeModelPath(modelPath) {
  let rel = String(modelPath ?? '')
  if (rel.startsWith('models/')) rel = rel.slice('models/'.length)
  if (rel.startsWith('/')) rel = rel.slice(1)
  return rel
}

/**
 * The script leaves `$EXTRA_ARGS` unquoted so it word-splits. We do the same,
 * explicitly, rather than passing one argument containing spaces — which
 * llama-server would reject.
 */
export function splitExtraArgs(extraArgs) {
  return String(extraArgs ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * @param {object} spec
 * @param {string} spec.containerName
 * @param {string} spec.image
 * @param {number} spec.hostPort
 * @param {string} spec.modelsDir absolute host path
 * @param {string} spec.modelPath relative to modelsDir (a leading `models/` is tolerated)
 * @param {string} [spec.mmprojPath] vision projector, relative to modelsDir
 * @param {string} [spec.specType] speculative decoding strategy; '' means off
 * @param {string} [spec.specDraftModel] draft model, relative to modelsDir
 * @param {number} [spec.specDraftNMax] draft tokens per step
 * @param {number} spec.ctxSize
 * @param {number} spec.gpuLayers
 * @param {number} spec.threads
 * @param {string} spec.apiKey
 * @param {string} [spec.extraArgs] empty means "autodetected upstream"
 * @param {string[]} [spec.rpcPeers] `host:port` workers to distribute layers over
 * @param {Record<string,string>} [spec.labels]
 * @returns {string[]}
 */
export function buildRunArgv(spec) {
  const {
    containerName,
    image,
    hostPort,
    modelsDir,
    modelPath,
    mmprojPath = '',
    specType = '',
    specDraftModel = '',
    specDraftNMax,
    ctxSize,
    gpuLayers,
    threads,
    apiKey,
    extraArgs = EXTRA_ARGS_OLD,
    rpcPeers = [],
    labels = {},
  } = spec

  const rel = normalizeModelPath(modelPath)
  const containerModelPath = `${CONTAINER_MODELS_DIR}/${rel}`
  const mmprojRel = normalizeModelPath(mmprojPath)

  const argv = [
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--device',
    '/dev/dri',
    '--device',
    '/dev/kfd',
    '--group-add',
    'video',
    '--group-add',
    'render',
    '--security-opt',
    'seccomp=unconfined',
    '-p',
    `${hostPort}:${CONTAINER_PORT}`,
    '--name',
    containerName,
  ]

  // Our own labels come after --name so a diff against the script's argv shows
  // them as one contiguous block rather than interleaved.
  for (const [key, value] of Object.entries(labels)) {
    argv.push('--label', `${key}=${value}`)
  }

  argv.push(
    '-v',
    `${modelsDir}:${CONTAINER_MODELS_DIR}:z`,
    image,
    'llama-server',
    '-m',
    containerModelPath,
    '--jinja',
    '--port',
    String(CONTAINER_PORT),
    '--host',
    '0.0.0.0',
    '--ctx-size',
    String(ctxSize),
    '--n-gpu-layers',
    String(gpuLayers),
    '--threads',
    String(threads),
    '--api-key',
    apiKey,
  )

  // A vision model needs its projector alongside the weights; without it
  // llama-server loads but silently refuses every image. Emitted right after
  // the model so the two always read together in `podman inspect`.
  if (mmprojRel) argv.push('--mmproj', `${CONTAINER_MODELS_DIR}/${mmprojRel}`)

  // Speculative decoding. The draft model travels with the strategy and is
  // never emitted without one: every strategy this app offers drafts from a
  // second model, and llama-server accepts `--spec-type` on its own only to
  // then draft nothing at all.
  if (specType) {
    argv.push('--spec-type', specType)
    const draftRel = normalizeModelPath(specDraftModel)
    if (draftRel) argv.push('--spec-draft-model', `${CONTAINER_MODELS_DIR}/${draftRel}`)
    if (Number.isFinite(specDraftNMax)) {
      argv.push('--spec-draft-n-max', String(specDraftNMax))
    }
  }

  // Only emitted for a cluster run. Without peers the argv must stay byte-for-byte
  // what run-llama-server.sh produces, which is what dev/parity checks.
  if (rpcPeers.length) argv.push('--rpc', rpcArgument(rpcPeers))

  argv.push(...splitExtraArgs(extraArgs))

  return argv
}

/**
 * Builds the `podman run` argv for a ggml-rpc-server worker.
 *
 * Deliberately a sibling of buildRunArgv rather than a branch inside it: that
 * function is a faithful transcription of run-llama-server.sh and is diffed
 * against the real script by dev/parity. A worker has no counterpart there, so
 * folding it in would mean the parity harness no longer covers the whole
 * function.
 *
 * A worker needs no model mount and takes no API key — the RPC protocol has
 * no authentication of any kind, which is why the caller must be deliberate
 * about which address it publishes on.
 *
 * @param {object} spec
 * @param {string} spec.containerName
 * @param {string} spec.image
 * @param {number} spec.hostPort published port on the host
 * @param {string} [spec.bindAddress] host interface to publish on; '' means all
 * @param {string} [spec.cacheVolume] named volume for the local tensor cache
 * @param {Record<string,string>} [spec.labels]
 * @returns {string[]}
 */
export function buildRpcRunArgv(spec) {
  const {
    containerName,
    image,
    hostPort,
    bindAddress = '',
    cacheVolume,
    labels = {},
  } = spec

  // podman reads `ip:host:container`; omitting the ip means every interface.
  const publish = bindAddress
    ? `${bindAddress}:${hostPort}:${RPC_PORT}`
    : `${hostPort}:${RPC_PORT}`

  const argv = [
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--device',
    '/dev/dri',
    '--device',
    '/dev/kfd',
    '--group-add',
    'video',
    '--group-add',
    'render',
    '--security-opt',
    'seccomp=unconfined',
    '-p',
    publish,
    '--name',
    containerName,
  ]

  for (const [key, value] of Object.entries(labels)) {
    argv.push('--label', `${key}=${value}`)
  }

  // `-c` makes the worker cache tensors on disk, which is the difference
  // between a fast and a very slow second start. Without a volume that cache
  // lives in the container's writable layer and dies with `podman rm`.
  if (cacheVolume) argv.push('-v', `${cacheVolume}:/root/.cache:z`)

  argv.push(
    image,
    'ggml-rpc-server',
    '-H',
    '0.0.0.0',
    '-p',
    String(RPC_PORT),
    '-c',
  )

  return argv
}

const flag = (value) => (value ? '1' : '0')

/**
 * The media API container's environment, as ordered name/value pairs.
 *
 * Everything the service reads is set explicitly rather than left to the
 * image's ENV, so the paths always match the mounts below. Secrets appear only
 * as `*_FILE` paths. A limit the user left empty is not passed, and neither is
 * the memory check for the mock backend — config.py switches that off for
 * mock on its own, and a forced `strict` would reject every mock job against
 * the real models' 36–86 GB estimates.
 *
 * @param {object} config a mediaConfigSchema object
 * @param {{hfToken?: boolean}} [opts] whether a token file is mounted
 * @returns {[string, string][]}
 */
export function mediaContainerEnv(config, { hfToken = false } = {}) {
  const env = [
    // Not a setting of the service but of the libraries under it: Triton
    // compiles its ROCm kernels into $HOME/.triton, and numba, torch
    // extensions and the XDG caches write below $HOME as well. The image sets
    // no HOME, so it would be /root — mode 0550 in the Fedora rootfs, and
    // without CAP_DAC_OVERRIDE (--cap-drop=all) even root cannot write there:
    // the first real generation died on it. /data/home is writable and
    // persistent, so the Triton cache survives restarts instead of recompiling.
    ['HOME', `${MEDIA_CONTAINER_DATA_DIR}/home`],
    ['MEDIA_HOST', '0.0.0.0'],
    ['MEDIA_PORT', String(MEDIA_PORT)],
    ['MEDIA_API_KEY_FILE', MEDIA_SECRET_MOUNTS.apiKey],
    ['MEDIA_SESSION_SECRET_FILE', MEDIA_SECRET_MOUNTS.sessionSecret],
    ['MEDIA_MODELS_DIR', MEDIA_CONTAINER_MODELS_DIR],
    ['MEDIA_OUTPUT_DIR', `${MEDIA_CONTAINER_DATA_DIR}/outputs`],
    ['MEDIA_UPLOAD_DIR', `${MEDIA_CONTAINER_DATA_DIR}/uploads`],
    ['MEDIA_STATE_DIR', `${MEDIA_CONTAINER_DATA_DIR}/state`],
    ['MEDIA_BACKEND', config.backend],
    ['MEDIA_ALLOW_DOWNLOADS', flag(config.allowDownloads)],
  ]
  if (config.backend !== 'mock') {
    env.push(['MEDIA_MEMORY_CHECK', config.memoryCheck])
    env.push(['MEDIA_MEMORY_RESERVE_GB', String(config.memoryReserveGb)])
  }
  env.push(
    ['MEDIA_DISABLE_MMAP', flag(config.disableMmap)],
    ['MEDIA_LOG_LEVEL', config.logLevel],
    ['MEDIA_COOKIE_SECURE', flag(config.cookieSecure)],
    ['MEDIA_ALLOW_X_API_KEY', flag(config.allowXApiKey)],
    ['MEDIA_SESSION_TTL_SECONDS', String(config.sessionTtlHours * 3600)],
  )
  if (config.corsOrigins?.length) env.push(['MEDIA_CORS_ORIGINS', config.corsOrigins.join(',')])
  for (const limit of MEDIA_LIMITS) {
    const value = config.limits?.[limit.key]
    if (value !== null && value !== undefined) env.push([limit.env, String(value)])
  }
  // huggingface_hub reads the token from this file; the value never becomes
  // part of the container's configuration.
  if (hfToken) env.push(['HF_TOKEN_PATH', MEDIA_SECRET_MOUNTS.hfTokenFile])
  return env
}

/** podman's `-p`: loopback by default, `ip:host:container` always. */
export function mediaPublish(bindAddress, hostPort) {
  return `${bindAddress || '127.0.0.1'}:${hostPort}:${MEDIA_PORT}`
}

/**
 * Builds the `podman run` argv for the media API.
 *
 * A third sibling of buildRunArgv, for the same reason buildRpcRunArgv is one:
 * buildRunArgv is a transcription of run-llama-server.sh that dev/parity diffs
 * against the real script, and folding another shape into it would leave that
 * check covering only part of the function. Its reference is not a script but
 * the hardened command documented in toolboxes_media_api/README.md and
 * build.sh, and server/test/media-parity.test.js holds this argv to every
 * documented flag.
 *
 * It runs on the host's Podman exactly as llama-server and the RPC worker do — the
 * same devices and the same `video`/`render` groups — and keeps what those two
 * do not have: no capabilities, no privilege escalation, secrets as read-only
 * files, the model tree read-only and the port on loopback unless the settings
 * publish it wider.
 *
 * The mock backend needs no GPU, so it gets no devices and keeps podman's
 * seccomp filter: `seccomp=unconfined` is what ROCm requires, not something
 * to hand out when nothing uses ROCm.
 *
 * No command is passed: the image starts the service itself.
 *
 * @param {object} spec
 * @param {string} spec.containerName
 * @param {string} spec.image
 * @param {number} spec.hostPort
 * @param {string} [spec.bindAddress] host address to publish on
 * @param {string} spec.modelsDir absolute host path of the model tree
 * @param {boolean} [spec.modelsReadOnly]
 * @param {string} spec.dataDir absolute host path for outputs, uploads, job state
 * @param {'real'|'mock'} [spec.backend]
 * @param {{apiKey: string, sessionSecret: string, hfToken?: string|null}} spec.secretFiles host paths
 * @param {[string, string][]} [spec.env] from mediaContainerEnv()
 * @param {Record<string,string>} [spec.labels]
 * @returns {string[]}
 */
export function buildMediaRunArgv(spec) {
  const {
    containerName,
    image,
    hostPort,
    bindAddress = '127.0.0.1',
    modelsDir,
    modelsReadOnly = true,
    dataDir,
    backend = 'real',
    secretFiles,
    env = [],
    labels = {},
  } = spec
  const gpu = backend !== 'mock'

  const argv = ['run', '-d', '--restart', 'unless-stopped']
  if (gpu) {
    argv.push('--device', '/dev/dri', '--device', '/dev/kfd', '--group-add', 'video', '--group-add', 'render')
  }
  argv.push('--cap-drop=all', '--security-opt=no-new-privileges')
  if (gpu) argv.push('--security-opt=seccomp=unconfined')
  argv.push('-p', mediaPublish(bindAddress, hostPort), '--name', containerName)

  for (const [key, value] of Object.entries(labels)) {
    argv.push('--label', `${key}=${value}`)
  }
  for (const [key, value] of env) argv.push('-e', `${key}=${value}`)

  argv.push(
    '-v',
    `${secretFiles.apiKey}:${MEDIA_SECRET_MOUNTS.apiKey}:ro,z`,
    '-v',
    `${secretFiles.sessionSecret}:${MEDIA_SECRET_MOUNTS.sessionSecret}:ro,z`,
  )
  if (secretFiles.hfToken) {
    argv.push('-v', `${secretFiles.hfToken}:${MEDIA_SECRET_MOUNTS.hfTokenDir}:ro,z`)
  }
  argv.push(
    '-v',
    `${modelsDir}:${MEDIA_CONTAINER_MODELS_DIR}:${modelsReadOnly ? 'ro,z' : 'z'}`,
    '-v',
    `${dataDir}:${MEDIA_CONTAINER_DATA_DIR}:z`,
    image,
  )
  return argv
}

/**
 * One-shot fetch containers: a name per job, so cancelling or cleaning up one
 * can never hit another, and a label that marks them as ours to clean up.
 */
export const MEDIA_FETCH_LABEL = 'shx.media-fetch'
export function mediaFetchContainer(jobId) {
  return `shx-media-fetch-${String(jobId).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`
}

/** Options every one-shot media container shares: the service's hardening, minus the GPU. */
const ONE_SHOT_HARDENING = ['--cap-drop=all', '--security-opt=no-new-privileges']

/**
 * `media-api-models check --json` in a throwaway container.
 *
 * No network, no GPU, no secret and a read-only model tree: all it does is
 * read the registry baked into the image and look at which files exist.
 *
 * @param {{image: string, modelsDir: string}} spec
 */
export function buildMediaCheckArgv({ image, modelsDir }) {
  return [
    'run',
    '--rm',
    '--network=none',
    ...ONE_SHOT_HARDENING,
    '-v',
    `${modelsDir}:${MEDIA_CONTAINER_MODELS_DIR}:ro,z`,
    '-e',
    `MEDIA_MODELS_DIR=${MEDIA_CONTAINER_MODELS_DIR}`,
    image,
    'media-api-models',
    'check',
    '--json',
  ]
}

/** The same check inside the running service, which knows its own MEDIA_CONFIG. */
export function buildMediaExecCheckArgv(containerName) {
  return ['exec', containerName, 'media-api-models', 'check', '--json']
}

/**
 * `media-api-models fetch … --json` in a throwaway container.
 *
 * The only place the model tree is mounted writable: the service keeps its
 * read-only mount, as toolboxes_media_api/README.md asks. The Hugging Face
 * token, if any, is a 0600 file of this one job, mounted read-only and named
 * by HF_TOKEN_PATH — never a value in the environment, so neither a process
 * list nor `podman inspect` shows it.
 *
 * `model`, `profile` and `task` have been matched against the image's own
 * inventory before they get here; they are ids, not paths.
 *
 * @param {object} spec
 * @param {string} spec.image
 * @param {string} spec.modelsDir
 * @param {string} spec.model
 * @param {string} spec.profile
 * @param {string} spec.name from mediaFetchContainer()
 * @param {string} [spec.task]
 * @param {string|null} [spec.tokenFile] host path of the job's token file
 * @param {boolean} [spec.disableXet]
 */
export function buildMediaFetchArgv(spec) {
  const {
    image,
    modelsDir,
    model,
    profile,
    task,
    name,
    tokenFile = null,
    disableXet = false,
  } = spec
  const argv = [
    'run',
    '--rm',
    '--name',
    name,
    '--label',
    `${MEDIA_FETCH_LABEL}=true`,
    ...ONE_SHOT_HARDENING,
    '-v',
    `${modelsDir}:${MEDIA_CONTAINER_MODELS_DIR}:z`,
  ]
  if (tokenFile) argv.push('-v', `${tokenFile}:${MEDIA_SECRET_MOUNTS.hfToken}:ro,z`)
  argv.push(
    '-e',
    `MEDIA_MODELS_DIR=${MEDIA_CONTAINER_MODELS_DIR}`,
    '-e',
    `HF_HOME=${MEDIA_CONTAINER_MODELS_DIR}/huggingface`,
  )
  if (tokenFile) argv.push('-e', `HF_TOKEN_PATH=${MEDIA_SECRET_MOUNTS.hfToken}`)
  argv.push('-e', disableXet ? 'HF_HUB_DISABLE_XET=1' : 'HF_XET_HIGH_PERFORMANCE=1')
  argv.push(image, 'media-api-models', 'fetch', model, '--profile', profile)
  if (task) argv.push('--task', task)
  argv.push('--json')
  return argv
}

/** Name of the per-worker cache volume. Derived so two workers never share one. */
export function rpcCacheVolume(containerName) {
  return `shx-rpc-cache-${containerName}`
}

/** The host-side path the model must exist at before we start the container. */
export function hostModelPath(modelsDir, modelPath) {
  return `${modelsDir.replace(/\/+$/, '')}/${normalizeModelPath(modelPath)}`
}
