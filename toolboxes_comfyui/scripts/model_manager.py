#!/usr/bin/env python3
import sys
import os
import shutil
import tempfile
import subprocess
from pathlib import Path

# --- Configuration ---
# Hardcoded paths for Docker environment
SCRIPT_DIR = Path("/opt")
WORKFLOW_DIRS = (
    Path("/opt/comfy-workflows"),
    Path("/opt/ComfyUI/user/default/workflows"),
)

# --- Model Families Configuration ---
# Group workflows by "Functionality". 
# The manager will scan for *any* workflow matching "keywords" to enable the entry.
# Then, depending on the "variants", it will either auto-select or prompt the user.

MODEL_FAMILIES = [
    # --- Qwen Image ---
    {
        "name": "Qwen Image (Base 20B)",
        "keywords": ["Qwen-Image"],
        # Exclude "LoRA" and "Edit" to differentiate from the other Qwen families
        "exclude_keywords": ["LoRA", "Edit", "GGUF"],
        "script": "get_qwen_image.sh",
        "variants": [
            {
                "name": "BF16 (Standard / High Quality)", 
                "args": ["1 bf16"]
            },
            {
                "name": "FP8 (Compressed / Low Disk Usage)", 
                "args": ["1"]
            }
        ]
    },
    {
        "name": "Qwen Image + Lightning LoRA (4-steps)",
        "keywords": ["Qwen-Image", "LoRA"],
        "exclude_keywords": ["GGUF"],
        "script": "get_qwen_image.sh",
        "variants": [
            {
                "name": "BF16 (Standard / High Quality)", 
                "args": ["1 bf16", "3"]
            },
            {
                "name": "FP8 (Compressed / Low Disk Usage)", 
                "args": ["1", "3"]
            }
        ]
    },

    # --- Qwen Edit ---
    {
        "name": "Qwen Image Edit (Base)",
        "keywords": ["Qwen-Image-Edit"],
        "exclude_keywords": ["LoRA", "GGUF"],
        "script": "get_qwen_image.sh",
        "variants": [
            {
                "name": "BF16 (Standard / High Quality)", 
                "args": ["2 bf16"]
            },
            {
                "name": "FP8 (Compressed / Low Disk Usage)", 
                "args": ["2"]
            }
        ]
    },
    {
        "name": "Qwen Image Edit + Lightning LoRA",
        "keywords": ["Qwen-Image-Edit", "LoRA"],
        "exclude_keywords": ["GGUF"],
        "script": "get_qwen_image.sh",
        "variants": [
            {
                "name": "BF16 (Standard / High Quality)", 
                "args": ["2 bf16", "4"]
            },
            {
                "name": "FP8 (Compressed / Low Disk Usage)", 
                "args": ["2", "4"]
            }
        ]
    },
    {
        "name": "Qwen Image 2512 GGUF Q4_K_M",
        "keywords": ["Qwen-Image-2512", "GGUF", "20-Steps"],
        "script": "get_qwen_image.sh",
        "variants": [
            {
                "name": "Q4_K_M diffusion model + Q4 text encoder",
                "args": ["5"]
            }
        ]
    },
    {
        "name": "Qwen Image 2512 GGUF + Lightning LoRA",
        "keywords": ["Qwen-Image-2512", "GGUF", "LoRA"],
        "script": "get_qwen_image.sh",
        "variants": [
            {
                "name": "Q4_K_M diffusion model + Q4 text encoder + 4-step LoRA",
                "args": ["5", "3"]
            }
        ]
    },
    {
        "name": "Qwen Image Edit 2511 GGUF Q4_K_M",
        "keywords": ["Qwen-Image-Edit-2511", "GGUF", "20-Steps"],
        "script": "get_qwen_image.sh",
        "variants": [
            {
                "name": "Q4_K_M diffusion model + Q4 text encoder",
                "args": ["6"]
            }
        ]
    },
    {
        "name": "Qwen Image Edit 2511 GGUF + Lightning LoRA",
        "keywords": ["Qwen-Image-Edit-2511", "GGUF", "LoRA"],
        "script": "get_qwen_image.sh",
        "variants": [
            {
                "name": "Q4_K_M diffusion model + Q4 text encoder + 4-step LoRA",
                "args": ["6", "4"]
            }
        ]
    },

    # --- Wan 2.2 ---
    {
        "name": "Wan 2.2 - Image to Video (14B)",
        "keywords": ["Wan2.2", "I2V"],
        "script": "get_wan22.sh",
        "variants": [
            {
                "name": "FP16 (Standard / High Quality)", 
                "args": ["common fp16", "14b-i2v fp16", "lora"]
            },
            {
                "name": "FP8 (Compressed / Low Disk Usage)", 
                "args": ["common", "14b-i2v", "lora"]
            }
        ]
    },
    {
        "name": "Wan 2.2 - Text to Video (14B)",
        "keywords": ["Wan2.2", "T2V"],
        "script": "get_wan22.sh",
        "variants": [
            {
                "name": "FP16 (Standard / High Quality)", 
                "args": ["common fp16", "14b-t2v fp16", "lora"]
            },
            {
                "name": "FP8 (Compressed / Low Disk Usage)", 
                "args": ["common", "14b-t2v", "lora"]
            }
        ]
    },

    # --- Hunyuan 1.5 ---
    {
        "name": "HunyuanVideo 1.5 - Image to Video (720p)",
        "keywords": ["Hunyuan", "i2v"],
        "script": "get_hunyuan15.sh",
        "variants": [
            {
                "name": "Standard (FP16)", 
                "args": ["common", "720p-i2v", "lora"]
            }
        ]
    },
    {
        "name": "HunyuanVideo 1.5 - Text to Video (720p)",
        "keywords": ["Hunyuan", "t2v"],
        "script": "get_hunyuan15.sh",
        "variants": [
            {
                "name": "Standard (FP16)", 
                "args": ["common", "720p-t2v", "lora"]
            }
        ]
    },

    # --- LTX-2.3 ---
    {
        "name": "LTX-2.3 BF16 Dev + Distilled LoRA",
        "keywords": ["LTX-2.3", "BF16", "Dev", "LoRA"],
        "exclude_keywords": ["GGUF"],
        "script": "get_ltx2.sh",
        "variants": [
            {
                "name": "Native BF16 checkpoint + compact distilled 1.1 LoRA (128GB recommended)",
                "args": ["bf16-common", "bf16-dev", "bf16-loras"]
            }
        ]
    },
    {
        "name": "LTX-2.3 BF16 Distilled (No LoRA)",
        "keywords": ["LTX-2.3", "BF16", "Distilled", "No-LoRA"],
        "exclude_keywords": ["GGUF", "Dev"],
        "script": "get_ltx2.sh",
        "variants": [
            {
                "name": "Native BF16 distilled 1.1 checkpoint, no LoRAs (128GB recommended)",
                "args": ["bf16-common", "bf16-distilled"]
            }
        ]
    },
    {
        "name": "LTX-2.3 GGUF Q6_K Dev + Distilled LoRA",
        "keywords": ["LTX-2.3", "GGUF", "Q6_K", "Dev", "LoRA"],
        "script": "get_ltx2.sh",
        "variants": [
            {
                "name": "Q6_K dev model + full-rank distilled 1.1 LoRA (lower memory)",
                "args": ["gguf-common", "gguf-dev", "gguf-lora"]
            }
        ]
    },
    {
        "name": "LTX-2.3 GGUF Q6_K Distilled (No LoRA)",
        "keywords": ["LTX-2.3", "GGUF", "Q6_K", "Distilled", "No-LoRA"],
        "exclude_keywords": ["Dev"],
        "script": "get_ltx2.sh",
        "variants": [
            {
                "name": "Q6_K distilled model, no LoRAs (lower memory)",
                "args": ["gguf-common", "gguf-distilled"]
            }
        ]
    },

    # --- MiniMax-H3 ---
    {
        "name": "MiniMax-H3 T2V",
        "keywords": ["minimax-h3", "t2v"],
        "exclude_keywords": ["turbo", "gguf"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "T2V model + shared encoder and VAEs",
                "args": ["common", "fl2va"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 I2V",
        "keywords": ["minimax-h3", "i2v"],
        "exclude_keywords": ["turbo", "gguf"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "I2V model + shared encoder and VAEs",
                "args": ["common", "fl2va"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 R2V",
        "keywords": ["minimax-h3", "r2v"],
        "exclude_keywords": ["gguf"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "R2V model + shared encoder and VAEs",
                "args": ["common", "ref2va"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 Turbo T2V",
        "keywords": ["minimax-h3", "turbo", "t2v"],
        "exclude_keywords": ["gguf"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "Turbo LoRA + T2V model, encoder and VAEs",
                "args": ["common", "fl2va", "turbo"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 Turbo I2V",
        "keywords": ["minimax-h3", "turbo", "i2v"],
        "exclude_keywords": ["gguf"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "Turbo LoRA + I2V model, encoder and VAEs",
                "args": ["common", "fl2va", "turbo"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 GGUF Turbo T2V",
        "keywords": ["minimax-h3", "gguf", "turbo", "t2v"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "GGUF model and encoder + Turbo LoRA + shared VAEs",
                "args": ["gguf-common", "gguf-fl2va", "turbo"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 GGUF Turbo I2V",
        "keywords": ["minimax-h3", "gguf", "turbo", "i2v"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "GGUF model and encoder + Turbo LoRA + shared VAEs",
                "args": ["gguf-common", "gguf-fl2va", "turbo"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 GGUF T2V",
        "keywords": ["minimax-h3", "gguf", "t2v"],
        "exclude_keywords": ["turbo"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "UD-Q2_K_XL diffusion model + Q2_K_M text encoder",
                "args": ["gguf-common", "gguf-fl2va"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 GGUF I2V",
        "keywords": ["minimax-h3", "gguf", "i2v"],
        "exclude_keywords": ["turbo"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "UD-Q2_K_XL diffusion model + Q2_K_M text encoder",
                "args": ["gguf-common", "gguf-fl2va"]
            }
        ]
    },
    {
        "name": "MiniMax-H3 GGUF R2V",
        "keywords": ["minimax-h3", "gguf", "r2v"],
        "exclude_keywords": ["turbo"],
        "script": "get_minimax_h3.sh",
        "variants": [
            {
                "name": "Q2_K diffusion model + Q2_K_M text encoder",
                "args": ["gguf-common", "gguf-ref2va"]
            }
        ]
    },
]

def check_dependencies():
    """Checks if dialog is installed."""
    if not shutil.which("dialog"):
        print("Error: 'dialog' is required. Please install it (e.g., apt-get install dialog).")
        sys.exit(1)

def run_dialog(args):
    """Runs dialog and returns stderr (selection)."""
    with tempfile.NamedTemporaryFile(mode="w+") as tf:
        cmd = ["dialog"] + args
        try:
            subprocess.run(cmd, stderr=tf, check=True)
            tf.seek(0)
            return tf.read().strip()
        except subprocess.CalledProcessError:
            return None # User cancelled

def find_available_families():
    """
    Scans workflow directory and identifies which Model Families are relevant 
    (i.e., we have workflows for them).
    """
    workflow_dirs = [directory for directory in WORKFLOW_DIRS if directory.exists()]
    if not workflow_dirs:
        paths = "\n".join(str(directory) for directory in WORKFLOW_DIRS)
        run_dialog(["--msgbox", f"Error: Workflow directories not found:\n{paths}", "12", "60"])
        sys.exit(1)

    available_families = []
    
    # Get all json filenames once
    workflow_files = [
        workflow.name
        for directory in workflow_dirs
        for workflow in directory.glob("*.json")
    ]
    
    for family in MODEL_FAMILIES:
        # Check if ANY workflow matches this family's criteria
        for filename in workflow_files:
            # Check mandatory keywords (Case Insensitive)
            if not all(k.lower() in filename.lower() for k in family["keywords"]):
                continue
                
            # Check exclusions (Case Insensitive)
            if "exclude_keywords" in family:
                if any(ek.lower() in filename.lower() for ek in family["exclude_keywords"]):
                    continue
            
            # If we found a match, this family is available.
            available_families.append(family)
            break
            
    return available_families

def select_variant(family):
    """
    If a family has multiple variants (e.g. FP8 vs FP16), prompt the user.
    Otherwise return the single variant.
    """
    variants = family["variants"]
    
    if len(variants) == 1:
        return variants[0]
        
    # Construct menu for variants
    menu_items = []
    for i, v in enumerate(variants):
        menu_items.extend([str(i), v["name"]])
        
    choice = run_dialog([
        "--clear", "--backtitle", f"Configuration for: {family['name']}",
        "--title", "Select Precision / Variant",
        "--cancel-label", "Back",
        "--menu", "Choose which version to download:", "15", "60", "5"
    ] + menu_items)
    
    if not choice:
        return None
        
    return variants[int(choice)]

def execute_download(script_name, args):
    """Executes the download script using subprocess."""
    script_path = SCRIPT_DIR / script_name
    
    if not script_path.exists():
        # Fallback to local check or error
        if not Path(script_name).exists():
             run_dialog(["--msgbox", f"Script not found:\n{script_name}", "10", "60"])
             return

    # args is a list of command strings like ["common fp16", "lora"]
    # We construct the full command: "bash script.sh common fp16 && bash script.sh lora"
    cmds = []
    for arg_str in args:
        cmds.append(f"bash {script_path} {arg_str}")
        
    full_cmd = " && ".join(cmds)
    
    subprocess.run(["clear"])
    print(f"Executing: {full_cmd}")
    print("-" * 60)
    
    try:
        subprocess.run(full_cmd, shell=True)
    except KeyboardInterrupt:
        print("\nProcess interrupted by user.")
    
    print("-" * 60)
    input("Press Enter to return to the menu...")

def main():
    check_dependencies()
    
    while True:
        families = find_available_families()
        
        if not families:
            run_dialog(["--msgbox", "No matching workflows found in directory.", "8", "40"])
            sys.exit(0)

        menu_items = []
        for i, f in enumerate(families):
            menu_items.extend([str(i), f["name"]])

        choice = run_dialog([
            "--clear", "--backtitle", "AMD Ryzen AI Max \"Strix Halo\" ComfyUI Model Manager",
            "--title", "Model Manager",
            "--cancel-label", "Exit",
            "--menu", "Select a Model Family to download dependencies for:", "20", "80", "15"
        ] + menu_items)

        if not choice:
            subprocess.run(["clear"])
            sys.exit(0)
            
        selected_family = families[int(choice)]
        
        # Step 2: Select Variant (FP8 vs FP16/BF16)
        variant = select_variant(selected_family)
        
        if not variant:
            continue # User went back
            
        # Confirmation
        confirm_msg = (
            f"Model:   {selected_family['name']}\n"
            f"Variant: {variant['name']}\n\n"
            f"This will run '{selected_family['script']}' with args:\n"
            f"{variant['args']}\n\n"
            "Proceed?"
        )
        
        try:
            subprocess.run(["dialog", "--yesno", confirm_msg, "15", "60"], check=True)
            # Exit code 0 means Yes
            execute_download(selected_family["script"], variant["args"])
            
        except subprocess.CalledProcessError:
            pass # No/Cancel

if __name__ == "__main__":
    main()
