# AI Agent Context: AMD Strix Halo Llama.cpp Toolboxes

**Primary Goal:** This fork of [kyuz0/amd-strix-halo-toolboxes](https://github.com/kyuz0/amd-strix-halo-toolboxes) turns the upstream toolboxes — containers you *enter* — into containers that *start a server*, and adds a web interface to run the whole box from a browser: `llama-server` instances, RPC workers and ComfyUI, plus both model trees. Target hardware is AMD Ryzen AI Max "Strix Halo" (gfx1151) with up to 124 GiB of unified memory.

Upstream's own parts — the interactive toolboxes, the benchmark suite, the GitHub Pages site, the distributed-inference TUI and the GPU workload watcher — are deliberately **not** carried here; they live in the upstream repository.

## Core Technologies
*   **Containerization**: [Toolbx](https://containertoolbx.org/) (Fedora) or Distrobox (Ubuntu). Underneath, Docker/Podman is used to build base images.
*   **Inference Engine**: [Llama.cpp](https://github.com/ggerganov/llama.cpp)
*   **Hardware / Drivers**: AMD "Strix Halo" APUs (Gfx1151). Implementations depend on ROCm (v6.4.4, v7.x) and Vulkan (Mesa RADV, AMDVLK).

## Repository Structure Overview
*   `/toolboxes_llama_server/`: Dockerfiles for the `llama-server` images (`vulkan-radv`, `rocm-10.0`, `rocm-7.14`). Each is upstream's file with the shell CMD replaced by a server start. Also holds the VRAM estimator the web interface runs, and this directory's `Dockerfile.<tag>` names are what the image catalog offers.
*   `/toolboxes_comfyui/`: ComfyUI as a server image. Upstream's Dockerfile plus their `scripts/` and `workflows/`, vendored so the build needs no other repository — see its `UPSTREAM.md`.
*   `/webui/`: Express + React management interface (JWT-protected) for models, containers, images and app updates. Runs as a `systemd --user` service on the box. Node backend, no native npm modules by design, so `npm ci` stays reliable across Node upgrades.
*   `run-llama-server.sh`: starts one server from the command line. Kept above all because `dev/parity` runs *this* script against a fake podman and diffs its arguments against `argv.js` — delete it and that check dies.
*   `.github/workflows/`: GitHub Actions. The `llama-server` images rebuild when `llama.cpp` master moves (poller → build). Everything else is manual: the ComfyUI build is started by hand, since it pulls a full ROCm torch and clones five repositories. A weekly check only reports whether `toolboxes_comfyui/`'s vendored files have fallen behind upstream.

## Critical Technical Quirks (Important for Development)
*   **Flash Attention & no-mmap**: Running `llama-server` or `llama-cli` on Strix Halo *requires* `-fa 1` (flash attention) and `--no-mmap` to avoid memory fragmentation and crashes.
*   **Kernel memory params**: The optimal Strix Halo host configuration relies on custom boot parameters (`iommu=pt amdgpu.gttsize=126976 ttm.pages_limit=32505856`) to allocate unified RAM to the iGPU.
*   **Kernel Bugs**: Avoid kernels older than 6.18.4, and the specifically broken `linux-firmware-20251125`.

## General Instructions for Coding Agents
1.  **Container Builds**: When modifying `Dockerfile.*` files inside `/toolboxes_llama_server`, ensure the build output remains lean and only necessary runtime dependencies and Llama.cpp binaries are carried over. Those files are upstream's with one changed block — keep the diff against upstream that small. The same holds for `/toolboxes_comfyui`.
2.  **Documentation Synchronization**: If adding a new backend or feature, ensure `README.md` is updated simultaneously.
3.  **Device access**: Anything touching the GPU needs `/dev/dri` and `/dev/kfd` plus the `video` and `render` groups.
4.  **WebUI parity**: `webui/server/src/podman/argv.js` reproduces `run-llama-server.sh` exactly. If you change either one, run `npm run test:parity` in `webui/` — it diffs our argv against what the real script executes. Never use `shell: true` there; all subprocesses go through `webui/server/src/lib/exec.js` with argv arrays (enforced by ESLint).
