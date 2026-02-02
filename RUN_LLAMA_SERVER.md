# Llama Server Toolboxes - Quick Start

This guide shows how to pull and run the AMD Strix Halo Llama Server Docker images.

## Available Images

| Image | Description |
|-------|-------------|
| `vulkan-amdvlk` | Vulkan backend with AMDVLK driver |
| `vulkan-radv` | Vulkan backend with RADV driver (Mesa) |
| `rocm-6.4.4` | ROCm 6.4.4 backend |
| `rocm-7.1.1` | ROCm 7.1.1 backend |
| `rocm-7.2` | ROCm 7.2 backend |
| `rocm7-nightlies` | ROCm 7 nightly builds |

## Pulling Images

### Using the refresh script (for Podman Toolbox)

Refresh all toolboxes:
```bash
./refresh-toolboxes-llama-server.sh all
```

Refresh specific toolboxes:
```bash
./refresh-toolboxes-llama-server.sh llama-rocm-7.2
./refresh-toolboxes-llama-server.sh llama-vulkan-radv llama-rocm-7.2
```

### Using Docker/Podman directly

Pull a specific image:
```bash
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.2
```

Pull all images:
```bash
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:vulkan-amdvlk
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:vulkan-radv
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-6.4.4
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.1.1
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.2
docker pull docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm7-nightlies
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

### Vulkan Backends (AMDVLK / RADV)

**vulkan-amdvlk:**
```bash
docker run -it --rm \
  --device /dev/dri \
  --group-add video \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:vulkan-amdvlk
```

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

**rocm-6.4.4:**
```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-6.4.4
```

**rocm-7.1.1:**
```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.1.1
```

**rocm-7.2:**
```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.2
```

**rocm7-nightlies:**
```bash
docker run -it --rm \
  --device /dev/dri \
  --device /dev/kfd \
  --group-add video \
  --group-add render \
  --security-opt seccomp=unconfined \
  -p 11434:11434 \
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm7-nightlies
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
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.2
```

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
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.2
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
  docker.io/st3v0rr/amd-strix-halo-toolboxes:rocm-7.2 \
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
