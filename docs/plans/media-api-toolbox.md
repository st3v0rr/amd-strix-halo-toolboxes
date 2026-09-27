# Plan: Python Media API Toolbox for Strix Halo

## Goal

Add a new Docker image to this repository that exposes authenticated image and video generation through a stable Python HTTP API and a browser playground. It must run on AMD Strix Halo (`gfx1151`) using the repository's ROCm/PyTorch conventions, without depending on a running ComfyUI instance.

The first supported use cases are:

1. Text-to-image with Qwen-Image-2512.
2. Image editing with Qwen-Image-Edit-2511.
3. Text-to-video, image-to-video, and reference/start-end-image video generation with MiniMax H3 where the available model implementation supports those modes.

The image must not contain model weights. Models, Hugging Face cache, outputs, uploads, and job state must live in mounted directories.

## Architecture

Create a self-contained directory such as `toolboxes_media_api/` with:

- a Fedora/ROCm Dockerfile following the existing `toolboxes_comfyui` Strix Halo base conventions;
- a Python package using FastAPI;
- a model-provider abstraction with real Qwen and MiniMax adapters;
- lazy model loading and explicit unload/cleanup;
- a single-GPU job queue that prevents concurrent model loads;
- persistent job metadata and output references;
- a lightweight server-rendered or static playground UI served by FastAPI;
- configuration through environment variables and an optional YAML file;
- unit/integration tests that run without a GPU through an explicit mock backend;
- build and smoke-test scripts plus a manual GitHub Actions image build, analogous to the ComfyUI image;
- documentation in the root README and a dedicated README.

Do not modify or depend on the existing ComfyUI server at runtime. Reuse proven ROCm environment settings where appropriate, but do not blindly copy its `--gpu-only`, `HIGH_VRAM`, or disabled smart-memory behavior.

## Quantization recommendations and required profiles

Research and document the exact loader compatibility before coding. Do not claim support for a format that the selected Python inference stack cannot load.

### Qwen-Image-2512

- Recommended default: FP8 E4M3FN transformer with the existing FP8-scaled Qwen 2.5 VL text encoder and BF16 VAE where supported on `gfx1151`.
- Quality profile: BF16 transformer, opt-in only; warn about substantially higher peak memory.
- Low-memory profile: 4-bit/NF4 or another proven Diffusers-compatible quantization only if current ROCm support is verified. Do not use an NVIDIA-only BitsAndBytes path on AMD.
- Fast profile: Qwen-Image-2512 Lightning 4-step LoRA, paired with the correct Qwen-Image LoRA (never the Edit LoRA).

### Qwen-Image-Edit-2511

- Recommended default: the available FP8-mixed transformer with the shared Qwen text encoder and VAE.
- Quality profile: BF16 transformer, opt-in only.
- Fast profile: the dedicated Qwen-Image-Edit-2511 Lightning 4-step LoRA.

### MiniMax H3

- Recommended default: the existing pruned INT8 ConvRot FL2VA/REF2VA transformer files, NVFP4-AWQ Qwen3-VL text encoder, FP16 video VAE, and FP32 audio VAE.
- Fast profile: dedicated MiniMax H3 Turbo LoRA where compatible.
- GGUF Q2 variants may be documented as an optional later profile, but must not be presented as the primary direct-Python path unless a non-Comfy loader is verified.

Keep quantization/model definitions data-driven in configuration, including model ID/path, dtype/quantizer, estimated memory class, supported tasks, required auxiliary models, and LoRA.

## Authentication and security

A configurable API key is mandatory. Production startup must fail closed when no key is configured.

- API authentication: accept `Authorization: Bearer <key>` and optionally `X-API-Key`.
- Compare secrets with constant-time comparison.
- Never log API keys or include them in error details.
- Protect all model, generation, upload, job, result, and playground routes.
- An unauthenticated `/healthz` liveness endpoint is acceptable but must expose no sensitive state.
- The browser UI should use a login form that exchanges the API key for an HttpOnly, SameSite session cookie containing no raw key. Protect the playground itself, not only its API calls.
- Add CSRF protection to cookie-authenticated state-changing UI requests.
- Restrict upload sizes and MIME types, validate all numeric generation parameters, sanitize filenames, and prevent path traversal.
- Serve outputs through authorized endpoints rather than a public static directory.
- Do not enable permissive CORS by default.

## API contract

Implement versioned endpoints with OpenAPI documentation, including at minimum:

- `GET /healthz`
- `GET /api/v1/models`
- `POST /api/v1/images/generations`
- `POST /api/v1/images/edits`
- `POST /api/v1/videos/generations`
- `GET /api/v1/jobs/{job_id}`
- `POST /api/v1/jobs/{job_id}/cancel`
- `GET /api/v1/jobs/{job_id}/result`

Generation must be asynchronous. Return a job ID immediately. Define stable job states and structured errors. Validate task/model compatibility before queueing. Use one worker by default and reject or queue work predictably under load.

Support deterministic seeds, model/profile selection, width/height, steps, guidance, and output format. Video requests additionally support FPS, duration or frame count, optional start image, optional end/reference image, and audio enablement where supported.

## Model lifecycle

- Load models lazily.
- Keep at most one heavyweight model family resident by default.
- Explicitly release references, run garbage collection, and clear the PyTorch device cache when switching.
- Put configurable memory admission checks ahead of model loading.
- Avoid mmap by default on Strix Halo if measurements or existing project guidance require it.
- Never download models implicitly during a generation request unless explicitly enabled by configuration.
- Report missing files/configuration as actionable API errors instead of crashing the service.

## Playground UI

Provide a functional, dependency-light playground with:

- login/logout;
- task/model/profile selection;
- dynamic form fields for T2I, image edit, T2V, I2V, and reference/start-end use cases;
- image upload and preview;
- job status/progress polling;
- authenticated image/video result display and download;
- clear validation and backend errors;
- no JavaScript framework build requirement unless the repository already makes it materially simpler.

## Configuration

At minimum support:

- `MEDIA_API_KEY`
- `MEDIA_SESSION_SECRET` or a safely derived/validated alternative
- `MEDIA_CONFIG`
- `MEDIA_MODELS_DIR`
- `MEDIA_OUTPUT_DIR`
- `MEDIA_UPLOAD_DIR`
- `MEDIA_STATE_DIR`
- `MEDIA_HOST`
- `MEDIA_PORT`
- `MEDIA_BACKEND=real|mock`
- limits for upload bytes, queued jobs, prompt length, dimensions, frames, and retained results
- opt-in Hugging Face download/network behavior

Provide `.env.example` with placeholders only. Never commit a real secret.

## Testing and verification

The implementation is not complete until these pass locally:

- Python unit tests;
- API integration tests using the mock backend;
- authentication tests for API and UI, including wrong/missing keys;
- CSRF and path-traversal tests;
- queue serialization, cancellation, failure, and result authorization tests;
- model/task compatibility validation tests;
- lint and formatting checks;
- type checking if configured;
- Docker build or, if host constraints prevent it, a deterministic Dockerfile/static smoke validation plus an explicit report;
- container smoke test in mock mode that verifies health, login/API authentication, one image job, one edit job, and one video job end to end.

Do not run or download heavyweight AI models as part of ordinary tests.

## Repository integration

- Keep the existing ComfyUI build untouched except for shared documentation where necessary.
- Add a separate manually dispatched GitHub Actions build-and-publish workflow with moving and immutable tags.
- Update `README.md` and `AGENTS.md` with the new image, architecture, ports, security model, and maintenance commands.
- Follow existing image naming and Docker Hub conventions.
- Do not push, publish an image, create a GitHub release, or modify remote state.

## Review gates

Before declaring completion:

1. Run all new tests and relevant existing repository tests.
2. Inspect the complete Git diff.
3. Perform a dedicated security review of API-key/session handling, uploads, paths, subprocesses, model IDs, network/download controls, and output serving.
4. Perform an independent code review in a fresh context.
5. Fix all blocker/high findings and rerun tests.
6. Leave the working tree ready for the parent agent to inspect and commit; do not commit or push unless explicitly instructed by the parent.

## Deliverables

- Implementation plan retained in this file.
- New Docker image source and Python application.
- Real provider adapters and mock provider.
- Authenticated API and playground UI.
- Tests and test fixtures.
- Build/smoke tooling and CI workflow.
- Quantization/model compatibility documentation.
- Final implementation report listing exact commands run, results, known hardware-only verification gaps, and any model formats rejected as unsupported.
