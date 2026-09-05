# AMD Strix Halo Llama.cpp Toolboxes — llama-server fork

Run LLMs on **AMD Ryzen AI Max "Strix Halo"** integrated GPUs, using up to 124 GiB
of unified memory as VRAM.

This repository is a fork of
**[kyuz0/amd-strix-halo-toolboxes](https://github.com/kyuz0/amd-strix-halo-toolboxes)**.
Upstream builds container images you *enter* and work in interactively. This fork
takes three of those backends, turns them into containers that *start a
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

kyuz0's project is the foundation. All of it is still in this repository and
behaves as it does upstream — only the image-building workflows were repointed
(see [repository layout](#repository-layout)). Its parts, briefly:

| Part | What it is |
| :--- | :--- |
| `toolboxes/` | The Dockerfiles behind [`docker.io/kyuz0/amd-strix-halo-toolboxes`](https://hub.docker.com/r/kyuz0/amd-strix-halo-toolboxes/tags) — ROCm and Vulkan stacks with llama.cpp compiled in, meant to be entered with `toolbox enter` / `distrobox enter`. Rebuilt automatically whenever llama.cpp master moves. |
| `refresh-toolboxes.sh` | Creates and updates those interactive toolboxes on the host, with the right `/dev/dri`, `/dev/kfd` and group options (and RDMA options when `/dev/infiniband` exists). |
| [AI Toolbox Cockpit](https://github.com/kyuz0/ai-toolbox-cockpit) | Upstream's recommended installer and launcher for its toolboxes, with tested profiles for Toolbx, Distrobox, Podman and Docker. Lives in its own repository. |
| `benchmark/`, `docs/*.html` | The benchmark suite and the [interactive result viewer](https://kyuz0.github.io/amd-strix-halo-toolboxes/), including the [toolbox comparison](https://kyuz0.github.io/amd-strix-halo-toolboxes/toolbox-performance.html). |
| `toolboxes/gguf-vram-estimator.py` | Estimates VRAM for a GGUF at a given context size — see [docs/vram-estimator.md](docs/vram-estimator.md). |
| `scripts/run_distributed_llama.py` | A TUI that spreads one model across several Strix Halo machines over llama.cpp RPC. Set up SSH keys between the nodes, run it on the main node, follow the prompts. |
| `systemd/gpu-workload-watch/` | Switches TuneD profiles and raises cooling only while the GPU is busy — see its [README](systemd/gpu-workload-watch/README.md). |
| Host documentation | Kernel parameters, firmware pitfalls, building your own images: [docs/](docs/) and <https://strix-halo-toolboxes.com>. |

### The backends this fork mirrors

Upstream's stable set is `vulkan-radv` and `rocm-10.0`; everything else there is
experimental (ROCm 10.0 performance builds, EngramHalo, ROCmFPX,
Qwen3.8-Flash-Next, TheRock nightlies, PR builds) and lives only upstream — see
its [README](https://github.com/kyuz0/amd-strix-halo-toolboxes#supported-toolboxes)
and [DockerHub tags](https://hub.docker.com/r/kyuz0/amd-strix-halo-toolboxes/tags).

This fork builds those two, plus `rocm-7.14` as a fallback for the ROCm jump:

| Tag | Backend | Notes |
| :--- | :--- | :--- |
| `vulkan-radv` | Vulkan (Mesa RADV, Fedora 44) | Most compatible. The default here, and the right first choice. |
| `rocm-10.0` | ROCm 10.0 (Fedora 44) | Current ROCm Core SDK build for gfx1151. |
| `rocm-7.14` | ROCm 7.14 (Fedora 44) | The previous ROCm branch, kept here after upstream replaced it — useful if 10.0 misbehaves. |

`vulkan-amdvlk` and `rocm-6.4.4` are no longer built. Upstream retired both, and
maintaining them alone was not worth the CI time; the images already on Docker
Hub keep working, they just stop receiving new llama.cpp builds.

> Upstream's support is the reason this fork exists at all. If the toolboxes are
> useful to you, consider [buying kyuz0 a coffee](https://buymeacoffee.com/dcapitella).

---

## What this fork adds

| Part | What it is |
| :--- | :--- |
| `toolboxes_llama_server/` | The same backends, rebuilt with `llama-server` as the container command instead of an interactive shell. Model, port, context size, GPU layers, threads and API key come from environment variables; the server listens on **11434** inside the container. The ROCm images carry upstream's workaround for [llama.cpp issue #25992](https://github.com/ggml-org/llama.cpp/issues/25992), and all three keep RDMA support for llama.cpp RPC. |
| Published images | [`docker.io/st3v0rr/amd-strix-halo-toolboxes`](https://hub.docker.com/r/st3v0rr/amd-strix-halo-toolboxes/tags) — this fork's own builds. CI polls llama.cpp every four hours and rebuilds all three backends on a new commit, pushing both a moving tag (`vulkan-radv`) and an immutable one (`vulkan-radv_20260815T101500`). |
| `run-llama-server.sh` | Starts one such container with podman: devices, groups, port mapping, model mount and restart policy in a single command. Documented in [RUN_LLAMA_SERVER.md](RUN_LLAMA_SERVER.md). |
| `refresh-toolboxes-llama-server.sh` | The upstream refresh script pointed at this fork's images, for people who still want them as toolbx containers. |
| `toolboxes_comfyui/` | The same treatment for kyuz0's second project, [amd-strix-halo-comfyui-toolboxes](https://github.com/kyuz0/amd-strix-halo-comfyui-toolboxes): a copy of their Dockerfile whose final `CMD` starts ComfyUI on port 8000 instead of a shell — with `--listen 0.0.0.0` and the ROCm environment upstream only sets for login shells. Built with `./build.sh`, which fetches their `scripts/` and `workflows/` first. Published as `:comfyui`. |
| `webui/` | A browser interface for the whole box: an Express backend and a React frontend, installed as a systemd service. Runs llama-server, RPC workers and ComfyUI, and manages both model trees. See [webui/README.md](webui/README.md). |

### Which images do I want?

| | Upstream `kyuz0/…` | This fork `st3v0rr/…` |
| :--- | :--- | :--- |
| Container starts | an interactive shell | `llama-server` |
| Made for | experimenting, benchmarking, `llama-cli`, building | leaving a server running on the network |
| Backends | two stable + many experimental | three `llama-server` builds |
| Used by | `toolbox enter`, `refresh-toolboxes.sh` | `run-llama-server.sh`, the web interface |

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

`./refresh-toolboxes.sh all` updates them later. Inside the toolbox, llama.cpp's
router mode serves several models from one process:

```sh
llama-server --models-preset models.ini --host 0.0.0.0 --port 8080 --models-max 1 --parallel 1
```

See [docs/models.ini.example](docs/models.ini.example) for the preset format.

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
| 8000 | ComfyUI (default per container) | **nothing** — it has no login at all |
| 50052 | RPC worker (`ggml-rpc-server`) | **nothing** — never expose it |

---

## Flash attention and mmap

On Strix Halo, `llama-server` must run with flash attention and without mmap, or
it crashes and slows to a crawl. The spelling of those flags changed in llama.cpp:
older builds want `-fa 1 --no-mmap`, newer ones `-fa on --load-mode none`, and
each rejects or warns about the other. `run-llama-server.sh` and the web interface
both probe the image's `--help` output and pick the right pair; `--extra-args`
overrides the detection entirely.

---

## Repository layout

| Path | Origin | Contents |
| :--- | :--- | :--- |
| `toolboxes/` | upstream | Dockerfiles for the interactive images, plus patches and the VRAM estimator |
| `toolboxes_llama_server/` | fork | Dockerfiles for the three `llama-server` images |
| `toolboxes_comfyui/` | fork | Copy of kyuz0's ComfyUI Dockerfile that starts the server, plus its build script |
| `webui/` | fork | the management interface (Express + React, systemd service) |
| `run-llama-server.sh`, `refresh-toolboxes-llama-server.sh` | fork | launching and refreshing this fork's images |
| `refresh-toolboxes.sh` | upstream | creating and updating upstream's toolboxes |
| `benchmark/`, `docs/` | upstream | benchmark suite, result viewers, host documentation |
| `scripts/`, `systemd/` | upstream | distributed inference, GPU workload watcher |
| `.github/workflows/` | fork-adjusted | polls llama.cpp, builds and prunes this fork's images |

`main` is merged from `kyuz0/main` from time to time, so upstream's toolboxes,
benchmarks and documentation stay current here.

---

## More documentation

* [RUN_LLAMA_SERVER.md](RUN_LLAMA_SERVER.md) — the `llama-server` images in detail
* [webui/README.md](webui/README.md) — installation, operation, security, development
* [docs/vram-estimator.md](docs/vram-estimator.md) — memory planning
* [docs/building.md](docs/building.md) — building images yourself
* [docs/docker-compose-how-to.md](docs/docker-compose-how-to.md) — running via compose
* [docs/troubleshooting-firmware.md](docs/troubleshooting-firmware.md) — firmware pitfalls

## References

* [Upstream project](https://github.com/kyuz0/amd-strix-halo-toolboxes) and its [website](https://strix-halo-toolboxes.com)
* [Strix Halo Home Lab (deseven)](https://strixhalo-homelab.d7.wtf/) — including the [hardware database](https://strixhalo-homelab.d7.wtf/Hardware)
* [Strix Halo Testing Builds (lhl)](https://github.com/lhl/strix-halo-testing/tree/main)
* [AMD ROCm 7.14 installation guide](https://rocm.docs.amd.com/en/docs-7.14.0/install/rocm.html)
