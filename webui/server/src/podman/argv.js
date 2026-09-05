import {
  COMFY_CONTAINER_MODELS_DIR,
  COMFY_CONTAINER_OUTPUT_DIR,
  COMFY_PORT,
  CONTAINER_MODELS_DIR,
  CONTAINER_PORT,
  EXTRA_ARGS_OLD,
  RPC_PORT,
} from '../../../shared/constants.js'
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
 * @param {number} [spec.specDraftNMax] draft tokens per step, when specType is set
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

  // Speculative decoding. `--spec-draft-n-max` is only meaningful alongside a
  // strategy, so it is never emitted on its own — llama.cpp would accept it and
  // silently ignore it, which reads like the setting had an effect.
  if (specType) {
    argv.push('--spec-type', specType)
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

/**
 * Builds the `podman run` argv for a ComfyUI container.
 *
 * A third sibling of buildRunArgv and buildRpcRunArgv, for the same reason they
 * are siblings of each other: buildRunArgv is a transcription of
 * run-llama-server.sh that dev/parity diffs against the real script, and
 * folding another shape into it would leave that check covering only part of
 * the function.
 *
 * No command is passed. Unlike the llama images, whose CMD has to be overridden
 * to add flags, toolboxes_comfyui/Dockerfile.comfyui already starts ComfyUI
 * with the right arguments — including `--listen 0.0.0.0`, without which a
 * published port reaches nothing.
 *
 * @param {object} spec
 * @param {string} spec.containerName
 * @param {string} spec.image
 * @param {number} spec.hostPort published port on the host
 * @param {string} spec.modelsDir absolute host path holding the ComfyUI models
 * @param {string} spec.outputDir absolute host path for generated images
 * @param {Record<string,string>} [spec.labels]
 * @returns {string[]}
 */
export function buildComfyRunArgv(spec) {
  const { containerName, image, hostPort, modelsDir, outputDir, labels = {} } = spec

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
    `${hostPort}:${COMFY_PORT}`,
    '--name',
    containerName,
  ]

  for (const [key, value] of Object.entries(labels)) {
    argv.push('--label', `${key}=${value}`)
  }

  // Both mounts matter for different reasons: without the first ComfyUI finds
  // no models, without the second every generated image dies with the
  // container.
  argv.push(
    '-v',
    `${modelsDir}:${COMFY_CONTAINER_MODELS_DIR}:z`,
    '-v',
    `${outputDir}:${COMFY_CONTAINER_OUTPUT_DIR}:z`,
    image,
  )

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
