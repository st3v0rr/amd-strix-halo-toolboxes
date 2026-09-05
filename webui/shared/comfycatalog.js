/**
 * The model sets upstream's ComfyUI toolbox can download.
 *
 * A mirror of the `MODEL_FAMILIES` table and the `get_*.sh` usage blocks in
 * kyuz0/amd-strix-halo-comfyui-toolboxes. Mirrored on purpose rather than read
 * out of the image at runtime: a copy that falls behind is visible and fixable,
 * whereas a parser for someone else's Python breaks silently the day they
 * reformat it.
 *
 * The download itself is *not* reimplemented. Each entry names a script that
 * already ships in the image — resumable, and knowing which subfolder every
 * file belongs in. We only decide which one to run.
 *
 * Security note: `args` never comes from the client. The API takes an `id` from
 * this table and looks the arguments up here, because these end up in a command
 * line inside a container.
 */

/**
 * @typedef {object} ComfyDownload
 * @property {string} id stable identifier used by the API
 * @property {string} label what the user picks
 * @property {string} script the script inside the image, without a path
 * @property {string[]} args arguments passed to it, verbatim
 * @property {string} [note] anything worth knowing before starting it
 */

/** @type {{family: string, description: string, downloads: ComfyDownload[]}[]} */
export const COMFY_CATALOG = [
  {
    family: 'Qwen-Image',
    description: 'Bilder erzeugen und bearbeiten, 20B.',
    downloads: [
      {
        id: 'qwen-image-fp8',
        label: 'Qwen-Image 2512 (FP8)',
        script: 'get_qwen_image.sh',
        args: ['1'],
      },
      {
        id: 'qwen-image-bf16',
        label: 'Qwen-Image 2512 (BF16)',
        script: 'get_qwen_image.sh',
        args: ['1', 'bf16'],
        note: 'Deutlich größer als FP8, dafür ohne Qualitätsverlust.',
      },
      {
        id: 'qwen-image-edit-fp8',
        label: 'Qwen-Image-Edit 2511 (FP8)',
        script: 'get_qwen_image.sh',
        args: ['2'],
      },
      {
        id: 'qwen-image-edit-bf16',
        label: 'Qwen-Image-Edit 2511 (BF16)',
        script: 'get_qwen_image.sh',
        args: ['2', 'bf16'],
      },
      {
        id: 'qwen-image-lightning-lora',
        label: 'Qwen-Image Lightning LoRA (4 Schritte)',
        script: 'get_qwen_image.sh',
        args: ['3'],
        note: 'Braucht Qwen-Image 2512.',
      },
      {
        id: 'qwen-image-edit-lightning-lora',
        label: 'Qwen-Image-Edit Lightning LoRA (4 Schritte)',
        script: 'get_qwen_image.sh',
        args: ['4'],
        note: 'Braucht Qwen-Image-Edit 2511.',
      },
      {
        id: 'qwen-image-gguf',
        label: 'Qwen-Image 2512 GGUF (Q4_K_M)',
        script: 'get_qwen_image.sh',
        args: ['5'],
        note: 'Sparsamste Variante.',
      },
      {
        id: 'qwen-image-edit-gguf',
        label: 'Qwen-Image-Edit 2511 GGUF (Q4_K_M)',
        script: 'get_qwen_image.sh',
        args: ['6'],
      },
    ],
  },
  {
    family: 'Wan 2.2',
    description: 'Video aus Text oder Bild, 14B.',
    downloads: [
      {
        id: 'wan22-common',
        label: 'Gemeinsame Teile (Text-Encoder + VAEs)',
        script: 'get_wan22.sh',
        args: ['common'],
        note: 'Zuerst laden — die anderen Wan-Downloads brauchen das.',
      },
      { id: 'wan22-t2v-fp8', label: '14B Text→Video (FP8)', script: 'get_wan22.sh', args: ['14b-t2v'] },
      {
        id: 'wan22-t2v-fp16',
        label: '14B Text→Video (FP16)',
        script: 'get_wan22.sh',
        args: ['14b-t2v', 'fp16'],
      },
      { id: 'wan22-i2v-fp8', label: '14B Bild→Video (FP8)', script: 'get_wan22.sh', args: ['14b-i2v'] },
      {
        id: 'wan22-i2v-fp16',
        label: '14B Bild→Video (FP16)',
        script: 'get_wan22.sh',
        args: ['14b-i2v', 'fp16'],
      },
      {
        id: 'wan22-lora',
        label: 'Lightning LoRAs',
        script: 'get_wan22.sh',
        args: ['lora'],
        note: 'Für die 4-Schritt-Workflows.',
      },
    ],
  },
  {
    family: 'LTX-2.3',
    description: 'Video, 22B. BF16 ist auf gfx1151 der native Pfad.',
    downloads: [
      {
        id: 'ltx2-bf16-common',
        label: 'BF16: gemeinsame Teile',
        script: 'get_ltx2.sh',
        args: ['bf16-common'],
        note: 'Zuerst laden.',
      },
      { id: 'ltx2-bf16-dev', label: 'BF16: 22B dev', script: 'get_ltx2.sh', args: ['bf16-dev'] },
      {
        id: 'ltx2-bf16-distilled',
        label: 'BF16: 22B distilled (ohne LoRA)',
        script: 'get_ltx2.sh',
        args: ['bf16-distilled'],
      },
      { id: 'ltx2-bf16-loras', label: 'BF16: LoRAs', script: 'get_ltx2.sh', args: ['bf16-loras'] },
      {
        id: 'ltx2-gguf-common',
        label: 'GGUF: gemeinsame Teile',
        script: 'get_ltx2.sh',
        args: ['gguf-common'],
        note: 'Sparsamer Pfad, zuerst laden.',
      },
      { id: 'ltx2-gguf-dev', label: 'GGUF: 22B dev (Q6_K)', script: 'get_ltx2.sh', args: ['gguf-dev'] },
      {
        id: 'ltx2-gguf-distilled',
        label: 'GGUF: 22B distilled (Q6_K)',
        script: 'get_ltx2.sh',
        args: ['gguf-distilled'],
      },
      { id: 'ltx2-gguf-lora', label: 'GGUF: distilled LoRA', script: 'get_ltx2.sh', args: ['gguf-lora'] },
    ],
  },
  {
    family: 'HunyuanVideo 1.5',
    description: 'Video in 720p, dazu ein 1080p-Upscaler.',
    downloads: [
      {
        id: 'hunyuan15-common',
        label: 'Gemeinsame Teile',
        script: 'get_hunyuan15.sh',
        args: ['common'],
        note: 'Zuerst laden.',
      },
      { id: 'hunyuan15-t2v', label: '720p Text→Video', script: 'get_hunyuan15.sh', args: ['720p-t2v'] },
      { id: 'hunyuan15-i2v', label: '720p Bild→Video', script: 'get_hunyuan15.sh', args: ['720p-i2v'] },
      {
        id: 'hunyuan15-upscale',
        label: '1080p-Upscaler',
        script: 'get_hunyuan15.sh',
        args: ['upscale'],
      },
      { id: 'hunyuan15-lora', label: 'LoRAs (4 Schritte)', script: 'get_hunyuan15.sh', args: ['lora'] },
    ],
  },
  {
    family: 'MiniMax H3',
    description: 'Video mit Ton.',
    downloads: [
      {
        id: 'minimax-common',
        label: 'Gemeinsame Teile',
        script: 'get_minimax_h3.sh',
        args: ['common'],
        note: 'Zuerst laden.',
      },
      { id: 'minimax-fl2va', label: 'Text→Video und Bild→Video', script: 'get_minimax_h3.sh', args: ['fl2va'] },
      { id: 'minimax-ref2va', label: 'Referenz→Video', script: 'get_minimax_h3.sh', args: ['ref2va'] },
      { id: 'minimax-turbo', label: 'Turbo-LoRA', script: 'get_minimax_h3.sh', args: ['turbo'] },
      {
        id: 'minimax-gguf-common',
        label: 'GGUF: gemeinsame Teile',
        script: 'get_minimax_h3.sh',
        args: ['gguf-common'],
        note: 'Sparsamer Pfad, zuerst laden.',
      },
      { id: 'minimax-gguf-fl2va', label: 'GGUF: Text/Bild→Video', script: 'get_minimax_h3.sh', args: ['gguf-fl2va'] },
      { id: 'minimax-gguf-ref2va', label: 'GGUF: Referenz→Video', script: 'get_minimax_h3.sh', args: ['gguf-ref2va'] },
    ],
  },
]

/** Every download, flattened — the lookup the API uses. */
export function findComfyDownload(id) {
  for (const family of COMFY_CATALOG) {
    const found = family.downloads.find((d) => d.id === id)
    if (found) return { ...found, family: family.family }
  }
  return null
}
