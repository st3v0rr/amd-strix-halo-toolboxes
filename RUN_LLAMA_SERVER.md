# Llama Server Toolboxes - Quick Start

This guide shows how to pull and run the AMD Strix Halo Llama Server Docker images.

## Available Images

| Image | Description |
|-------|-------------|
| `vulkan-radv` | Vulkan backend with RADV driver (Mesa, Fedora 44). Most stable and compatible — recommended for most models. |
| `rocm-10.0` | ROCm 10.0 backend (Fedora 44). Current stable ROCm Core SDK build. |
| `rocm-7.14` | ROCm 7.14 backend (Fedora 44). The previous ROCm branch, kept as a fallback if 10.0 misbehaves. |

These mirror the stable backends of the upstream project
[`kyuz0/amd-strix-halo-toolboxes`](https://github.com/kyuz0/amd-strix-halo-toolboxes),
with `llama-server` as the container entrypoint instead of a shell. Upstream
builds `vulkan-radv` and `rocm-10.0`; `rocm-7.14` is kept here after upstream
replaced it.

> **Prefer a browser?** [`webui/`](webui/README.md) does everything on this page —
> pulling images, downloading models, starting and stopping servers, live logs —
> from a JWT-protected web interface that autostarts with the machine.
> Install it with `cd webui && ./install.sh`.

> The retired tags `rocm-7.1.1`, `rocm-7.2`, `rocm7-nightlies`, `rocm-6.4.4` and
> `vulkan-amdvlk` are no longer built. Existing images stay on Docker Hub but
> receive no new llama.cpp builds — use `rocm-10.0` or `vulkan-radv` instead.

## Pulling Images

### Using the refresh script (for Podman Toolbox)

Refresh all toolboxes:
```bash
./refresh-toolboxes-llama-server.sh all
```

Refresh specific toolboxes:
```bash
./refresh-toolboxes-llama-server.sh llama-rocm-10.0
./refresh-toolboxes-llama-server.sh llama-vulkan-radv llama-rocm-10.0
```

### Using Docker/Podman directly

Pull a specific image:
```bash
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-10.0
```

Pull all images:
```bash
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:vulkan-radv
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-10.0
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.14
```

## Running Images

The images come with default configuration and will automatically start `llama-server` when run.

### Default Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL_PATH` | `/workspace/models/gpt-oss-120b-F16/gpt-oss-120b-F16.gguf` | Path to the model file |
| `PORT` | `11434` | Server port |
| `CTX_SIZE` | `90000` | Context size |
| `GPU_LAYERS` | `999` | Number of GPU layers to offload |
| `THREADS` | `16` | Number of CPU threads |
| `API_KEY` | `abcde` | API key for authentication |

### Vulkan Backend (RADV)

**vulkan-radv:**
```bash
docker run -it --rm \
  --device /dev/dri \
  --group-add video \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:vulkan-radv
```

### ROCm Backends

**rocm-10.0:**
```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-10.0
```

**rocm-7.14:**
```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.14
```

## Running with Custom Model

To use your own model, mount the model directory and override the `MODEL_PATH` environment variable:

```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  -v /path/to/models:/workspace/models \
  -e MODEL_PATH=/workspace/models/my-model.gguf \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-10.0
```

## Vision Models

A multimodal model needs its projector alongside the weights. Pass it with
`--mmproj`, relative to the models directory just like `--model`:

```bash
./run-llama-server.sh \
  --model Qwen3-VL-8B-GGUF/Qwen3-VL-8B-Q8_0.gguf \
  --mmproj Qwen3-VL-8B-GGUF/mmproj-F16.gguf \
  --api-key example-key
```

The script checks that the file exists before starting the container. Without a
projector the server comes up fine and then refuses every image, with nothing in
the log pointing at the cause.

The web interface finds the projector for a selected model on its own — see
[webui/README.md](webui/README.md#vision-modelle).

## Running with Custom Configuration

Override multiple environment variables:

```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -p 8080:8080 \
  -v /path/to/models:/workspace/models \
  -e MODEL_PATH=/workspace/models/my-model.gguf \
  -e PORT=8080 \
  -e CTX_SIZE=4096 \
  -e GPU_LAYERS=99 \
  -e THREADS=8 \
  -e API_KEY=my-secret-key \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-10.0
```

## VRAM Estimation

The images include a helper script to estimate VRAM usage for GGUF models:

```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -v /path/to/models:/workspace/models \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-10.0 \
  gguf-vram-estimator.py /workspace/models/model.gguf
```

## Testing the Server

Once the server is running, test it with curl:

```bash
# With API key
curl http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer abcde" \
  -d '{
    "model": "gpt-oss-120b-F16",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# With custom API key 
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret-key" \
  -d '{
    "model": "my-model",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```
