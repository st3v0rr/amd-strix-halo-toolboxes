#!/usr/bin/env bash
# Detect and export ROCm toolchain paths from the _rocm_sdk_core package

# Enable AOTriton for torch
export TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1

# Ensure ROCm uses recent PRs for hipblaslt performance improvement on gfx1151/gfx1101
# Refs: ROCm/rocm-libraries#3913, ROCm/rocm-libraries#3879
export TORCH_BLAS_PREFER_HIPBLASLT=1
