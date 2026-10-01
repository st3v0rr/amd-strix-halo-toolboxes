# AMD Strix Halo Llama.cpp Toolboxes — llama-server fork

Run LLMs on **AMD Ryzen AI Max "Strix Halo"** integrated GPUs, using up to 124 GiB
of unified memory as VRAM.

This repository is a fork of
**[kyuz0/amd-strix-halo-toolboxes](https://github.com/kyuz0/amd-strix-halo-toolboxes)**.
Upstream builds container images you *enter* and work in interactively. This fork
takes a few of those backends, turns them into containers that *start a
server* instead of a shell, and adds a web interface to manage the whole box —
models, servers, images, updates — from a browser.

Both halves are described below: [what upstream provides](#what-upstream-provides)
and [what this fork adds](#what-this-fork-adds).

> [!IMPORTANT]
> This repository is part of the **[Strix Halo AI Toolboxes](https://strix-halo-toolboxes.com/)**
> project. Follow the central guide for the recommended host setup, including
> unified-memory allocation and OS-specific configuration.

---

## What upstream provides

kyuz0's project is the foundation, and everything below still applies to a
Strix Halo box — but it is **not** carried in this repository. This fork keeps
only what it builds and runs itself; for the rest, go to
[the upstream repository](https://github.com/kyuz0/amd-strix-halo-toolboxes). Worth knowing about:

| Part | Where |
| :--- | :--- |
| Interactive toolboxes | The Dockerfiles behind [`docker.io/kyuz0/amd-strix-halo-toolboxes`](https://hub.docker.com/r/kyuz0/amd-strix-halo-toolboxes/tags) — ROCm and Vulkan stacks with llama.cpp compiled in, entered with `toolbox enter` / `distrobox enter`: [`toolboxes/`](https://github.com/kyuz0/amd-strix-halo-toolboxes/tree/main/toolboxes) |
| `refresh-toolboxes.sh` | Creates and updates those interactive toolboxes on the host, with the right `/dev/dri`, `/dev/kfd` and group options: [refresh-toolboxes.sh](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/refresh-toolboxes.sh) |
| [AI Toolbox Cockpit](https://github.com/kyuz0/ai-toolbox-cockpit) | Upstream's recommended installer and launcher for its toolboxes, with tested profiles for Toolbx, Distrobox, Podman and Docker. |
| Benchmarks | The suite and the [interactive result viewer](https://kyuz0.github.io/amd-strix-halo-toolboxes/), including the [toolbox comparison](https://kyuz0.github.io/amd-strix-halo-toolboxes/toolbox-performance.html): [`benchmark/`](https://github.com/kyuz0/amd-strix-halo-toolboxes/tree/main/benchmark) |
| VRAM estimator | Estimates VRAM for a GGUF at a given context size. A copy lives in `toolboxes_llama_server/`, which is the one the web interface runs; upstream's documentation is [docs/vram-estimator.md](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/docs/vram-estimator.md). |
| Distributed inference | A TUI that spreads one model across several machines over llama.cpp RPC: [`scripts/run_distributed_llama.py`](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/scripts/run_distributed_llama.py). The web interface here can start RPC workers and a cluster head on its own. |
| GPU workload watcher | Switches TuneD profiles and raises cooling only while the GPU is busy: [`systemd/gpu-workload-watch/`](https://github.com/kyuz0/amd-strix-halo-toolboxes/tree/main/systemd/gpu-workload-watch) |
| Host documentation | Kernel parameters, firmware pitfalls, building your own images: [docs/](https://github.com/kyuz0/amd-strix-halo-toolboxes/tree/main/docs) and <https://strix-halo-toolboxes.com>. |

### The backends this fork mirrors

Upstream's stable set is `vulkan-radv` and `rocm-10.0`; everything else there is
experimental (ROCm 10.0 performance builds, EngramHalo, ROCmFPX,
Qwen3.8-Flash-Next, TheRock nightlies, PR builds) and lives only upstream — see
its [README](https://github.com/kyuz0/amd-strix-halo-toolboxes#supported-toolboxes)
and [DockerHub tags](https://hub.docker.com/r/kyuz0/amd-strix-halo-toolboxes/tags).

This fork builds those two, plus one of the experimental ones:

| Tag | Backend | Notes |
| :--- | :--- | :--- |
| `vulkan-radv` | Vulkan (Mesa RADV, Fedora 44) | Most compatible. The default here, and the right first choice. |
| `rocm-10.0` | ROCm 10.0 (Fedora 44) | Current ROCm Core SDK build for gfx1151. |
| `rocm-10.0-strix-llama` | ROCm 10.0 + custom ROCr/HIP (Experimental) | [`halo-box/strix-llama.cpp`](https://github.com/halo-box/strix-llama.cpp) on a retained-PM4 runtime built from [`pwilkin/rocm-systems:ilintar-experiments`](https://github.com/pwilkin/rocm-systems/tree/ilintar-experiments). Upstream measured 1207 t/s prompt processing and 43.9 t/s decode on Qwen3.8-Flash-Next Q4_K_XL with its MTP head. Rebuilt when either source branch moves (40–60 minutes); see [below](#the-strix-llama-image). |

#### The strix-llama image

Nothing in it is pinned: every build takes the heads of both branches, and
`/opt/strix/versions.txt` inside the image records which revisions went in.
It does not follow llama.cpp master either, so it is not in the `all` set that
the llama.cpp poller builds. Its own poller, `poll-strix-llama.yaml`, checks
both branches every four hours and builds only when one of them has moved. To
force a build, run *Build & Publish* with `backends=rocm-10.0-strix-llama`.

Its llama-server knows `--lazy-mode on-direct`, which reads Qwen3.8-Flash-Next's
28.8 GB per-layer embedding table with `pread()` instead of keeping it resident.
The web interface and `run-llama-server.sh` detect that from `llama-server --help`
and start it with `-fa on --load-mode none --lazy-mode on-direct`; set extra
arguments by hand and that detection is skipped, so include all three then.
Vision (`--mmproj`) and `draft-mtp` with the MTP head work as with the other
images. Upstream's measured command adds more, which fits in the extra arguments
if you want to reproduce it:
`-b 16384 -ub 16384 --parallel 1 --spec-draft-device ROCm0 --spec-draft-ngl all --mmproj-device ROCm0`.

Two warnings from upstream. Never set `GGML_CUDA_ENABLE_UNIFIED_MEMORY` — with
retained PM4 it corrupts output (garbage tokens, `init: invalid token` with the
MTP draft). And a fork of ROCm is a fork of ROCm: compare a few real prompts at
`temp 0` against `vulkan-radv` before relying on it.

`vulkan-amdvlk`, `rocm-6.4.4` and `rocm-7.14` are no longer built. Upstream retired all
three, and maintaining them alone was not worth the CI time; the images already on Docker
Hub keep working, they just stop receiving new llama.cpp builds.

> Upstream's support is the reason this fork exists at all. If the toolboxes are
> useful to you, consider [buying kyuz0 a coffee](https://buymeacoffee.com/dcapitella).

---

## What this fork adds

| Part | What it is |
| :--- | :--- |
| `toolboxes_llama_server/` | The same backends, rebuilt with `llama-server` as the container command instead of an interactive shell. Model, port, context size, GPU layers, threads and API key come from environment variables; the server listens on **11434** inside the container. The ROCm images carry upstream's workaround for [llama.cpp issue #25992](https://github.com/ggml-org/llama.cpp/issues/25992), and all of them keep RDMA support for llama.cpp RPC. |
| Published images | [`docker.io/st3v0rr/amd-strix-halo-toolboxes`](https://hub.docker.com/r/st3v0rr/amd-strix-halo-toolboxes/tags) — this fork's own builds. CI polls llama.cpp every four hours and rebuilds `vulkan-radv` and `rocm-10.0` on a new commit, pushing both a moving tag (`vulkan-radv`) and an immutable one (`vulkan-radv_20260815T101500`). |
| `run-llama-server.sh` | Starts one such container with podman: devices, groups, port mapping, model mount and restart policy in a single command. Documented in [RUN_LLAMA_SERVER.md](RUN_LLAMA_SERVER.md). |
| `toolboxes_media_api/` | Image and video generation as an authenticated API: Qwen-Image-2512 (text → image), Qwen-Image-Edit-2511 (edit) and MiniMax-H3 (text/image/start-end/reference → video with audio) on diffusers, with a browser playground, a single-GPU job queue and lazy model loading. Its model tree is `~/media-api-models` by default, beside `~/media-api-data` for outputs and job state. Port **8100**, fails closed without `MEDIA_API_KEY`. Published as `:media-api`; see [its README](toolboxes_media_api/README.md). |
| `webui/` | A browser interface for the whole box: an Express backend and a React frontend, installed as a systemd service. Runs llama-server, RPC workers and the media API — all three started from its Servers page on the box's own Podman, the media API through a small dialog, with its key and session secret as read-only files it never displays — and manages the model trees, including a **MediaAPI-Modelle** page for the curated Qwen-Image and MiniMax-H3 profiles, fetched only on request. The same app is an MCP server at `/mcp`, so Claude Desktop, Claude Code or Hermes Agent can run the box too. See [webui/README.md](webui/README.md). |

### Which images do I want?

| | Upstream `kyuz0/…` | This fork `st3v0rr/…` |
| :--- | :--- | :--- |
| Container starts | an interactive shell | `llama-server` |
| Made for | experimenting, benchmarking, `llama-cli`, building | leaving a server running on the network |
| Backends | two stable + many experimental | two stable + `rocm-10.0-strix-llama` |
| Used by | `toolbox enter`, upstream's `refresh-toolboxes.sh` | the web interface, or `run-llama-server.sh` |

They coexist happily on one machine — different image names, different
containers.

---

## Quick start

### Option A — the web interface

The whole workflow in a browser: search and download models from Hugging Face,
start and stop `llama-server` containers, follow their logs live, watch GPU and
GTT usage as well as throughput per network interface (USB4/Thunderbolt links
included), save server profiles, pull new images, update the app itself, and run
one model across several machines via llama.cpp RPC.

```bash
cd webui
./install.sh
```

The installer checks the prerequisites, builds the frontend, installs a
`systemd --user` unit (or a system unit when run as root), enables lingering, and
prints the URL plus a **one-time password**. It serves on port **8420** and comes
back after a reboot, optionally restarting the servers you marked for autostart.

Details, firewall rules and troubleshooting: [webui/README.md](webui/README.md).
Note that the interface itself is in German.

### Option B — one command per server

```bash
HF_XET_HIGH_PERFORMANCE=1 hf download unsloth/Qwen3.6-27B-GGUF \
  Qwen3.6-27B-Q8_0.gguf --local-dir models/Qwen3.6-27B-GGUF/

./run-llama-server.sh \
  --model Qwen3.6-27B-GGUF/Qwen3.6-27B-Q8_0.gguf \
  --api-key example-key
```

`--model` is relative to the models directory, which is mounted into the
container. Defaults: image `st3v0rr/…:vulkan-radv`, container `llamacpp-server`,
host port 11434, context 65536, models read from `./models`. `--image`, `--name`,
`--port`, `--ctx-size`, `--gpu-layers`, `--threads`, `--models-dir` and
`--extra-args` override them; `--help` lists everything, and
[RUN_LLAMA_SERVER.md](RUN_LLAMA_SERVER.md) has worked examples per backend,
including running two servers side by side.

### Option C — an interactive toolbox

Unchanged from upstream, and still the best way to poke around, benchmark, or use
`llama-cli` (Ubuntu: `distrobox` instead of `toolbox`):

```bash
toolbox create llama-vulkan-radv \
  --image docker.io/kyuz0/amd-strix-halo-toolboxes:vulkan-radv \
  -- --device /dev/dri --group-add video --security-opt seccomp=unconfined

toolbox enter llama-vulkan-radv
llama-cli --list-devices
```

Upstream's [`refresh-toolboxes.sh`](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/refresh-toolboxes.sh) updates
them later; it is not carried here. Inside the toolbox, llama.cpp's router mode
serves several models from one process:

```sh
llama-server --models-preset models.ini --host 0.0.0.0 --port 8080 --models-max 1 --parallel 1
```

See [docs/models.ini.example](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/docs/models.ini.example) for the
preset format.

---

## Host configuration

This is the part that decides whether Strix Halo works at all, and it is the same
for upstream and this fork.

**Known-good base**: Fedora 42/43, kernel 6.18.9, linux-firmware 20260110. Kernels
older than 6.18.4 have a gfx1151 bug, and `linux-firmware-20251125` breaks ROCm —
avoid both.

**Kernel parameters**, to hand the iGPU up to 124 GiB while leaving the OS 4 GiB:

```
amd_iommu=off amdgpu.gttsize=126976 ttm.pages_limit=32505856
```

| Parameter | Purpose |
| :--- | :--- |
| `amd_iommu=off` | Disables the AMD IOMMU. 5–12 % faster than either IOMMU-enabled mode, including the previously recommended `iommu=pt` ([benchmarks](https://github.com/kyuz0/amd-strix-halo-toolboxes/issues/66#issuecomment-4460612951)). |
| `amdgpu.gttsize=126976` | Caps GPU unified memory at 124 GiB. |
| `ttm.pages_limit=32505856` | Caps pinned memory at the same 124 GiB. |

```bash
sudo grub2-mkconfig -o /boot/grub2/grub.cfg
sudo reboot
```

Your user needs the `video` and `render` groups, or `--device /dev/kfd` fails:

```bash
sudo usermod -aG video,render "$USER"   # log out and back in
```

Ubuntu 24.04 users: follow
[TechnigmaAI's guide](https://github.com/technigmaai/technigmaai-wiki/wiki/AMD-Ryzen-AI-Max--395:-GTT--Memory-Step%E2%80%90by%E2%80%90Step-Instructions-%28Ubuntu-24.04%29)
for the GTT memory setup.

### Ports

| Port | What | Protected by |
| :--- | :--- | :--- |
| 8420 | the web interface | password + JWT cookie |
| 11434 | `llama-server` (default per server) | `--api-key` |
| 8100 | Media API (image/video generation) — the web interface publishes it on `127.0.0.1` unless started with „Im Netzwerk erreichbar“; plain HTTP, so let it through for one source only | API key (`Bearer`), playground: session cookie + CSRF |
| 50052 | RPC worker (`ggml-rpc-server`) | **nothing** — never expose it |

---

## Flash attention and mmap

On Strix Halo, `llama-server` must run with flash attention and without mmap, or
it crashes and slows to a crawl. The spelling of those flags changed in llama.cpp:
older builds want `-fa 1 --no-mmap`, newer ones `-fa on --load-mode none`, and
each rejects or warns about the other. `run-llama-server.sh` and the web interface
both probe the image's `--help` output and pick the right pair, adding
`--lazy-mode on-direct` where the build offers it (`rocm-10.0-strix-llama`);
`--extra-args` overrides the detection entirely.

---

## Repository layout

| Path | Origin | Contents |
| :--- | :--- | :--- |
| `toolboxes_llama_server/` | fork | Dockerfiles for the `llama-server` images |
| `toolboxes_media_api/` | fork | the media API image: Python/FastAPI service, playground, tests, `build.sh` |
| `webui/` | fork | the management interface (Express + React, systemd service) |
| `run-llama-server.sh` | fork | starts one server from the command line, and is the reference `npm run test:parity` checks the web interface against |
| `.github/workflows/` | fork-adjusted | polls llama.cpp and the strix-llama sources, builds and prunes this fork's images |

### Merging upstream

`main` is merged from `kyuz0/main` from time to time. Since this fork does not
carry `benchmark/`, `docs/`, `scripts/`, `systemd/` or `toolboxes/`, every
upstream commit that touches those raises a conflict here. Two things make that
routine rather than painful:

```bash
git fetch upstream
git merge -X no-renames upstream/main
git rm -rqf --ignore-unmatch benchmark docs scripts systemd toolboxes
# resolve what is left — those are real content conflicts — then commit
```

`-X no-renames` is the part that matters. Without it git pairs upstream's
`toolboxes/Dockerfile.*` with this fork's near-identical
`toolboxes_llama_server/Dockerfile.*`, reads the change as a rename, and drops
upstream's *interactive* toolboxes into the server directory — where the web
interface would then offer them as backends it cannot build. With it, the last
sync left three genuine conflicts instead of twenty-two.

---

## More documentation

* [RUN_LLAMA_SERVER.md](RUN_LLAMA_SERVER.md) — the `llama-server` images in detail
* [webui/README.md](webui/README.md) — installation, operation, security, development
* [toolboxes_media_api/README.md](toolboxes_media_api/README.md) — the media API: routes, profiles and loader compatibility, security model
* Upstream, for the host side: [vram-estimator](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/docs/vram-estimator.md),
  [building](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/docs/building.md),
  [docker-compose](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/docs/docker-compose-how-to.md),
  [firmware troubleshooting](https://github.com/kyuz0/amd-strix-halo-toolboxes/blob/main/docs/troubleshooting-firmware.md)

## References

* [Upstream project](https://github.com/kyuz0/amd-strix-halo-toolboxes) and its [website](https://strix-halo-toolboxes.com)
* [Strix Halo Home Lab (deseven)](https://strixhalo-homelab.d7.wtf/) — including the [hardware database](https://strixhalo-homelab.d7.wtf/Hardware)
* [Strix Halo Testing Builds (lhl)](https://github.com/lhl/strix-halo-testing/tree/main)
