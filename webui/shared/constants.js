/**
 * Constants shared by the server and the web client.
 *
 * Anything in here is imported by both sides, so it must stay free of Node
 * built-ins and browser globals alike.
 */

/** Image repository the fork publishes its llama-server toolboxes to. */
export const IMAGE_REPO = 'docker.io/st3v0rr/amd-strix-halo-toolboxes'

/** Port llama-server always listens on *inside* the container. */
export const CONTAINER_PORT = 11434

/** Where the models directory is mounted inside the container. */
export const CONTAINER_MODELS_DIR = '/workspace/models'

/**
 * ComfyUI's port inside the container, and the two paths it reads.
 *
 * The paths are fixed, not configurable: upstream's set_extra_paths.sh derives
 * the model directory from $HOME, so pointing ComfyUI elsewhere would mean
 * rewriting extra_model_paths.yaml ourselves. The host side of the mount is
 * what the user actually chooses.
 */
export const COMFY_PORT = 8000
export const COMFY_CONTAINER_MODELS_DIR = '/root/comfy-models'
export const COMFY_CONTAINER_OUTPUT_DIR = '/root/comfy-outputs'

/**
 * ComfyUI image tags this fork publishes.
 *
 * One, not two: upstream's `latest` and `dev` are the same source — they build
 * from main as `dev` and promote a tested one to `latest`. Building from source
 * ourselves, there is no second channel to inherit.
 */
export const COMFY_TAGS = /** @type {const} */ (['comfyui'])

/**
 * The model subfolders ComfyUI expects, as created by set_extra_paths.sh.
 * Listing them explicitly is what lets the models page show empty ones too —
 * an absent folder is a normal state, not an error.
 */
export const COMFY_MODEL_DIRS = /** @type {const} */ ([
  'checkpoints',
  'clip_vision',
  'diffusion_models',
  'latent_upscale_models',
  'loras',
  'text_encoders',
  'unet',
  'vae',
])

/**
 * Labels stamped onto every container we create. Ownership lives in the
 * container rather than in our own state file, so a wiped state.json or a
 * reboot never orphans a running server.
 */
export const LABEL = {
  managed: 'shx.managed',
  version: 'shx.version',
  role: 'shx.role',
  profile: 'shx.profile',
  model: 'shx.model',
  image: 'shx.image',
  ctx: 'shx.ctx',
  gpuLayers: 'shx.gpu-layers',
  threads: 'shx.threads',
  port: 'shx.port',
  extraArgs: 'shx.extra-args',
  mmproj: 'shx.mmproj',
  specType: 'shx.spec-type',
  specDraftNMax: 'shx.spec-draft-n-max',
  rpcPeers: 'shx.rpc-peers',
  comfyModelsDir: 'shx.comfy-models-dir',
  comfyOutputDir: 'shx.comfy-output-dir',
  created: 'shx.created',
}

/**
 * What a managed container actually is.
 *
 * `server` is a llama-server serving HTTP; `rpc` is a ggml-rpc-server offering
 * its GPU to someone else's llama-server; `comfy` is ComfyUI. Containers
 * created before this label existed carry no role and are read as `server` —
 * which is what they are.
 */
export const ROLE = /** @type {const} */ ({
  server: 'server',
  rpc: 'rpc',
  comfy: 'comfy',
})

/** Schema version of the label set, so a future migration can tell them apart. */
export const LABEL_VERSION = '1'

/**
 * Port ggml-rpc-server listens on inside the container.
 *
 * The same default scripts/run_distributed_llama.py uses, so a worker started
 * here is reachable by the TUI and vice versa.
 */
export const RPC_PORT = 50052

/**
 * Speculative decoding strategies we offer, as `--spec-type` values.
 *
 * llama.cpp knows more of them, but the rest (`draft-simple`, `draft-eagle3`,
 * `draft-dflash`, `draft-dspark`) need a second, smaller draft model passed
 * with `-md` — which this app has no notion of. What is listed here drafts from
 * the model itself, so it works with exactly the one file the user picked:
 *
 * - `draft-mtp` uses the multi-token-prediction layers baked into models that
 *   were trained with them (Qwen3-Next, DeepSeek V3, GLM-4.x …). On a model
 *   without those layers llama-server has nothing to draft from.
 * - `ngram-mod` drafts from repetition in the context, so it needs nothing from
 *   the model at all and helps most on code and structured output.
 *
 * See https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md
 */
export const SPEC_TYPES = /** @type {const} */ (['draft-mtp', 'ngram-mod'])

/** llama.cpp's own default for `--spec-draft-n-max`. */
export const SPEC_DRAFT_N_MAX_DEFAULT = 3

/** The two spellings of "flash attention + no mmap" llama.cpp has used. */
export const EXTRA_ARGS_NEW = '-fa on --load-mode none'
export const EXTRA_ARGS_OLD = '-fa 1 --no-mmap'

/** Header that must accompany every mutating request (CSRF defence). */
export const CSRF_HEADER = 'x-requested-with'
export const CSRF_VALUE = 'shx'

/** Name of the auth cookie. */
export const AUTH_COOKIE = 'shx_token'

/** Defaults mirroring run-llama-server.sh, used for new profiles and dialogs. */
export const SERVER_DEFAULTS = {
  ctxSize: 65536,
  gpuLayers: 999,
  threads: 12,
  port: 11434,
  image: `${IMAGE_REPO}:vulkan-radv`,
}

/** Container and profile names. Podman is stricter than this; we are stricter still. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/

/**
 * Login names. Deliberately roomier than NAME_RE — `@` and `+` let people use
 * an email address — but still free of whitespace and control characters, so a
 * name cannot be visually confused with another one.
 */
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/

/** Shortest password we accept when it is set through the API. */
export const MIN_PASSWORD_LENGTH = 8

/**
 * Multi-part GGUF files, e.g. `model-00001-of-00003.gguf`. Only the first shard
 * is ever passed to `-m`.
 */
export const SHARD_RE = /^(?<base>.*)-(?<idx>\d{5})-of-(?<total>\d{5})\.gguf$/i

/** Host ports we allow binding; below 1024 needs privileges rootless podman lacks. */
export const PORT_MIN = 1024
export const PORT_MAX = 65535

/** Job lifecycle. `interrupted` means the process died while we were restarted. */
export const JOB_STATUS = /** @type {const} */ ([
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
])

/** The states a job never leaves again; everything else is still in flight. */
export const JOB_FINISHED_STATUS = /** @type {const} */ ([
  'done',
  'failed',
  'cancelled',
  'interrupted',
])

export const JOB_TYPE = /** @type {const} */ ([
  'model-download',
  'comfy-model-download',
  'image-pull',
  'feature-detect',
  'app-update',
])
