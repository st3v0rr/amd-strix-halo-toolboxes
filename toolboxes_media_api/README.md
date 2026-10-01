# Media API — image and video generation for Strix Halo

An authenticated HTTP API plus a browser playground for **Qwen-Image-2512** (text → image),
**Qwen-Image-Edit-2511** (image edit) and **MiniMax-H3** (text/image/start-end/reference → video
with stereo audio), on AMD Ryzen AI Max "Strix Halo" (gfx1151). A Python service on diffusers —
no ComfyUI inside, none needed alongside. The image holds no weights: models, the Hugging Face
cache, outputs, uploads and job state live in mounts.

## Run it

```bash
install -d -m 700 "$HOME/.config/media-api"
umask 077
python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > "$HOME/.config/media-api/api-key"
./build.sh                                   # → media-api-local (TheRock ROCm torch, gfx1151)
podman run -d --name media-api \
  --device /dev/dri --device /dev/kfd --group-add video --group-add render \
  --cap-drop=all --security-opt=no-new-privileges --security-opt=seccomp=unconfined \
  -p 127.0.0.1:8100:8100 -e MEDIA_HOST=0.0.0.0 \
  -e MEDIA_API_KEY_FILE=/run/secrets/media-api-key \
  -v "$HOME/.config/media-api/api-key:/run/secrets/media-api-key:ro,z" \
  -v "$HOME/comfy-models:/models:ro,z" -v "$HOME/media-api-data:/data:z" \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:media-api
```

This is how the appliance runs it: as root, on the host's rootful Podman — the same Podman,
devices and `video`/`render` groups as its ComfyUI and llama.cpp containers, with no Podman mode
of its own to choose. Then open `http://127.0.0.1:8100/ui/`. Without a readable
`MEDIA_API_KEY_FILE` or valid `MEDIA_API_KEY` (or with the commented `.env.example` placeholder)
the container exits with status 2 — it never runs unprotected.

The ROCm userspace currently needs `seccomp=unconfined` on this platform. That disables syscall
filtering, and under rootful Podman a container escape means root on the appliance — the exposure
its ComfyUI and llama.cpp containers have as well. This container narrows it where those do not:
all capabilities dropped, `no-new-privileges`, secrets and model weights mounted read-only, and
`seccomp=unconfined` only for the real ROCm backend (the mock backend keeps Podman's filter). No
untested custom seccomp profile is provided. Keep the host port loopback-only unless you mean to
expose it (below).

### Remote access

Publishing port 8100 beyond loopback sends API keys and login credentials over plain HTTP. On a
trusted LAN the web interface can do exactly that (**Im Netzwerk erreichbar** when starting it), and
its Network page lets 8100 through for one source network only. For anything wider, keep
`-p 127.0.0.1:8100:8100`, terminate HTTPS in a reverse proxy on the same host, and set
`MEDIA_COOKIE_SECURE=1`. Configure only explicit HTTPS CORS origins if cross-origin API access is
needed. Prefer `MEDIA_API_KEY_FILE` and `MEDIA_SESSION_SECRET_FILE` mounted from mode-0600 files
(or Podman secrets) instead of environment values.

Model files use the ComfyUI tree layout, so an existing `~/comfy-models` can be mounted as-is
(read-only works) and its FP8 files are reused. Missing files are reported, never fetched behind
your back:

```bash
podman exec media-api media-api-models check                        # what each profile has/lacks
podman exec media-api media-api-models check --json                 # the same, machine-readable
```

`media-api-models` reads the registry and the model tree, never the API, so it needs no
`MEDIA_API_KEY` and runs in a one-shot container too. `check --json` prints one document
(`version: 1`, per profile `available`, `missing`, `tasks_available`, `downloadable`);
`fetch … --json` prints JSON lines — a `plan` with sizes from the Hub, then `file`/`fetched`
per entry, `done` or `error`. Every fetch (and the first-use download of `MEDIA_ALLOW_DOWNLOADS`)
first requires the files plus `MEDIA_MIN_FREE_DISK_BYTES` plus headroom (2 %, at least 1 GiB) to be
free. The CLI also runs a guard that ends the process (status 3, partials kept) once free space
drops below the reserve; only with that guard does it accept entries whose size the Hub does not
report — the service's own download refuses them. A token can come from `HF_TOKEN` or, better, a
read-only file named by `HF_TOKEN_PATH`. The web interface (`webui/`) manages the
service this way. **Media API starten** on its Servers page asks for a container name, a host
port, whether to publish beyond loopback and — optionally — a key of one's own, then runs the
command above; key and session secret are 0600 files mounted read-only and never shown. The page
**MediaAPI-Modelle** lists the curated models (Qwen-Image-2512, Qwen-Image-Edit-2511, MiniMax-H3)
with their profiles and fetches what a profile lacks only when asked, in a separate one-shot
container while the service keeps its read-only mount (new files appear at their paths only when
complete, so it needs no restart); the token reaches that container only as a per-job read-only
file.

Keep the service's model mount read-only. To fetch pinned model revisions by hand, use a
separate one-shot container with the model mount writable while the service keeps `:ro,z`; do
not make the network service's model mount writable. `MEDIA_ALLOW_DOWNLOADS=1` is therefore not
recommended for the hardened runtime.

`MEDIA_ALLOW_DOWNLOADS=1` lets a job fetch what it lacks on first use instead. Otherwise the
process sets `HF_HUB_OFFLINE=1` and all loads use `local_files_only`.

## API

All routes except `GET /healthz` need `Authorization: Bearer <key>` (or `X-API-Key: <key>`,
switchable off with `MEDIA_ALLOW_X_API_KEY=0`) or a playground session. The OpenAPI document is
at `GET /openapi.json` (authenticated).

| Route | |
| :--- | :--- |
| `GET /healthz` | liveness, `{"status":"ok"}` and nothing else |
| `GET /api/v1/models` | models, profiles, tasks, defaults, constraints, which files are missing |
| `POST /api/v1/uploads` | multipart `file` (PNG/JPEG/WebP) → `upl_…` id |
| `POST /api/v1/images/generations` | text → image |
| `POST /api/v1/images/edits` | `image_ids` (1–3) + prompt → image |
| `POST /api/v1/videos/generations` | text; `start_image_id`; `start_image_id`+`end_image_id` (or end only); `reference_image_ids` (≤ 9) |
| `GET /api/v1/jobs`, `GET /api/v1/jobs/{id}` | job state |
| `POST /api/v1/jobs/{id}/cancel` | cancel queued or running |
| `GET /api/v1/jobs/{id}/result[?download=1]` | the file |

```bash
curl -s -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"prompt":"a lighthouse at dusk","profile":"lightning-4step","seed":42}' \
  http://127.0.0.1:8100/api/v1/images/generations  # → 202 {"id":"job_…","status":"queued",…}
```

Generation is asynchronous: `202` with a job id at once, then `queued → running →
succeeded | failed | cancelled` (`stage` and `progress` while running). Common fields: `model`,
`profile`, `prompt`, `seed` (random and reported when omitted), `steps`, `width`/`height`,
`output_format` (`png|jpeg|webp`, video `mp4|webm`). Qwen adds `guidance` (true CFG) and
`negative_prompt`; video adds `fps`, `duration_seconds` or `num_frames`, and `audio`.

Everything that can be checked is checked **before** a job exists — task/model/profile
compatibility, sizes, frame grid, fps, unsupported parameters, upload ids, file availability —
and answered with `{"error":{"code","message","details"}}` (`capability_unsupported`,
`validation_error`, `unknown_model`, `model_files_missing`, `queue_full`, …). One worker runs
jobs in order; more than `MEDIA_MAX_QUEUED_JOBS` waiting → `429 queue_full`. Jobs survive a
restart as records; ones that were unfinished come back as `failed/interrupted`.

## Models, profiles and what loads them

Data-driven in [`data/models.yaml`](src/media_api/data/models.yaml): per profile the files
(path, repo, pinned revision), loader format, in-memory storage, tasks, memory estimate, LoRA.
`MEDIA_CONFIG` may add or replace models. Key layouts were checked name for name against the
real checkpoint headers (`tests/fixtures/checkpoint_keys.json.gz`).

| Model / profile | Weights | In memory | ≈ GB |
| :--- | :--- | :--- | ---: |
| qwen-image-2512 **fp8** (default) | Comfy-Org `qwen_image_2512_fp8_e4m3fn` + `qwen_2.5_vl_7b_fp8_scaled` + BF16 VAE | FP8 as stored (bit-exact), BF16 compute | 36 |
| qwen-image-2512 bf16 (quality, opt-in) | Comfy-Org BF16 transformer + text encoder | BF16 — about twice the peak memory | 64 |
| qwen-image-2512 lightning-4step (fast) | fp8 + lightx2v Qwen-Image-2512 Lightning 4-step LoRA (never the Edit LoRA) | LoRA fused, requantized per row | 36 |
| qwen-image-edit-2511 **fp8mixed** (default) | Comfy-Org `fp8mixed` | FP8 layers with their scales, BF16 layers stay BF16 | 36 |
| qwen-image-edit-2511 bf16 / lightning-4step | as above, with the dedicated Edit-2511 Lightning LoRA | | 64 / 36 |
| minimax-h3 **int8** (default) | MiniMaxAI/MiniMax-H3 diffusers BF16 | INT8 per row while streaming from disk (transformer + Qwen3-VL), BF16 video VAE, FP32 audio VAE | 86 |
| minimax-h3 turbo (fast) | int8 + larryvrh Turbo LoRA v4 (fused before quantizing), 6 steps; t2v/i2v/start-end only | | 86 |

FP8 and INT8 are *weight-only*: weights are dequantized per forward and multiplied in BF16
(`providers/quant.py`), the mechanism ComfyUI's FP8 weights already use on gfx1151. No
torchao, no bitsandbytes, no FP8 matmul. Tensors are copied out of the file mapping
(`MEDIA_DISABLE_MMAP=1`, as ComfyUI's `--disable-mmap`).

**Not offered.** These formats were checked and are left out of the registry
(`status: unsupported` still exists for a `MEDIA_CONFIG` entry, which then lists its reason):

- *NF4 / bitsandbytes* — no verified gfx1151 build for this ROCm torch (ROCm/TheRock#2945).
- *Qwen-Image GGUF Q4_K_M (unsloth)* — loads through diffusers' plain-PyTorch GGUF path, but its
  speed on gfx1151 was never measured; dropped as experimental.
- *Comfy-Org MiniMax-H3 `*_pruned_int8_convrot` + `qwen3vl_32b_minimax_h3_nvfp4_awq`* — the plan's
  suggested default, but the pruned transformer replaces the AdaLN MLP with a precomputed
  timestep table (`adaln_t_table`, 8-wide `adaln_proj`: diffusers reports a size mismatch), and
  INT8 ConvRot / NVFP4-AWQ are ComfyUI-only layouts. The int8 profile is the diffusers equivalent.
- *MiniMax-H3 GGUF (unsloth, pruned)* and the *Qwen2.5-VL GGUF text encoder* — ComfyUI-GGUF only.
- *Qwen-Image-Edit-2511 `int8_convrot`* — ComfyUI-only layout.
- *MiniMax-H3 Turbo for reference-to-video* — the Turbo LoRA was trained on the fl2va partition;
  lightx2v's ref2v LoRA carries `alpha: 8` metadata that conflicts with its own usage notes.

MiniMax-H3 facts the API enforces (from diffusers' pipeline): 24 fps only, 5–15 s with frames
snapped up to `17n+5` (124…345), sides multiples of 32 up to 1344×768 pixels, aspect 1:4–4:1,
guidance-distilled (no `guidance`, no `negative_prompt`), audio always generated jointly
(`audio:false` only drops it from the file). `steps` counts model evaluations.

## Model lifecycle

Nothing loads at startup. The first job loads its (model, profile); a job for another one
unloads it first — references dropped, `gc.collect()`, `torch.cuda.empty_cache()` — and only
then does the admission check compare the profile's estimate plus `MEDIA_MEMORY_RESERVE_GB`
with free memory (`MemAvailable`, which on Strix Halo is the GPU's memory too). If llama-server
or ComfyUI hold the memory, the job fails with `insufficient_memory` instead of the box
swapping. MiniMax-H3 keeps one transformer partition resident and swaps it for ref2va.

## Security model

- The key is compared in constant time (SHA-256 digests), never logged, stored or echoed;
  failed attempts are throttled per client (429).
- Playground login exchanges the key for a random server-side session: an `HttpOnly`,
  `SameSite=Strict` cookie with an HMAC-signed id — no key material. Logout and restarts end
  sessions. Any remote use requires a TLS reverse proxy and `MEDIA_COOKIE_SECURE=1`.
- Cookie-authenticated state changes need the session's CSRF token (`X-CSRF-Token`) and a
  same-origin `Origin`. The playground itself and its script are behind the login.
- Uploads: request and re-encoded PNG size caps, pixel limits, atomic aggregate count/byte quotas,
  and a minimum-free-disk reserve; content is sniffed against the declared type (PNG/JPEG/WebP
  only, no animation), then re-encoded to PNG. Incomplete file/metadata pairs are removed at
  startup and unreferenced uploads expire with job retention. Ids are server-generated and
  pattern-checked; every path is confined to its directory.
- Results are served only by authenticated routes; no static output directory. No CORS unless
  `MEDIA_CORS_ORIGINS` lists explicit origins (credentials never allowed). Strict CSP.
- The appliance runs the container on rootful Podman, like its ComfyUI and llama.cpp containers;
  it always gets `--cap-drop=all` and `--security-opt=no-new-privileges`, only `/data` is writable
  and models are mounted read-only. ROCm currently requires `seccomp=unconfined` — a documented
  residual risk that, rootful, would make an escape root on the host; hence port 8100 stays on
  loopback or goes to known sources only.

## Configuration

Environment (all in [`.env.example`](.env.example)): `MEDIA_API_KEY` (or `…_FILE`),
`MEDIA_SESSION_SECRET` (else derived from the key), `MEDIA_CONFIG`, `MEDIA_MODELS_DIR`,
`MEDIA_OUTPUT_DIR`, `MEDIA_UPLOAD_DIR`, `MEDIA_STATE_DIR`, `MEDIA_HOST`, `MEDIA_PORT` (8100),
`MEDIA_BACKEND=real|mock`, `MEDIA_ALLOW_DOWNLOADS`, `MEDIA_DEVICE`, `MEDIA_MEMORY_CHECK`,
`MEDIA_MEMORY_RESERVE_GB`, and the limits `MEDIA_MAX_UPLOAD_BYTES`,
`MEDIA_MAX_ENCODED_UPLOAD_BYTES`, `MEDIA_MAX_UPLOAD_COUNT`, `MEDIA_MAX_TOTAL_UPLOAD_BYTES`,
`MEDIA_MIN_FREE_DISK_BYTES`, `MEDIA_MAX_QUEUED_JOBS`,
`MEDIA_MAX_PROMPT_CHARS`, `MEDIA_MAX_WIDTH/HEIGHT`, `MEDIA_MAX_FRAMES`, `MEDIA_MAX_STEPS`,
`MEDIA_RESULT_TTL_HOURS`, `MEDIA_MAX_RETAINED_JOBS`. The YAML file takes the same settings
under `server:`, `paths:`, `security:`, `limits:` plus `models:`; secrets in it are refused.

## Development

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements/dev.txt && pip install -e .
pytest && ruff check src tests && ruff format --check src tests && mypy
```

`MEDIA_BACKEND=mock` runs the whole service without torch or a GPU (deterministic output).
`tests/test_real_adapters.py` checks the real adapters on CPU when torch, torchvision and
`requirements/inference.txt` are installed; with
`MEDIA_TEST_TINY_H3=<dir of hf-internal-testing/tiny-minimax-h3-modular-pipe>` (44 MB of random
test weights) both providers run end to end through diffusers.

Container build: `./build.sh [--cpu-torch]`. CI: *Build & Publish Media API* (manual) runs
the tests, builds and pushes `:media-api` and `:media-api_<timestamp>`. There is no container
check in CI — the runner has no GPU, so the image is checked on the Strix Halo box itself.

**Not verified here:** real inference on gfx1151. Loaders, key layouts and both pipelines are
exercised on CPU with random weights; speed, memory estimates and output quality of the real
weights on a Strix Halo box still need a first run there.
