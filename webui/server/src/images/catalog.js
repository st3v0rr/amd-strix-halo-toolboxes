import fs from 'node:fs'

import { IMAGE_REPO } from '../../../shared/constants.js'
import { comfyDockerfileDir, dockerfileDir } from '../config/paths.js'
import { log } from '../lib/log.js'

/**
 * Where the tags come from. Each directory holds `Dockerfile.<tag>` files, and
 * `kind` is what the images page uses to tell a llama-server backend from
 * ComfyUI — they are unrelated software that merely shares a DockerHub repo.
 */
const SOURCES = [
  { dir: dockerfileDir, kind: 'llama' },
  { dir: comfyDockerfileDir, kind: 'comfy' },
]

/** Hard fallback if the repo layout is ever unreadable (e.g. tarball install). */
const FALLBACK_TAGS = [
  { tag: 'vulkan-radv', kind: 'llama' },
  { tag: 'rocm-7.14', kind: 'llama' },
  { tag: 'rocm-10.0', kind: 'llama' },
  { tag: 'comfyui', kind: 'comfy' },
]

const DESCRIPTIONS = {
  'vulkan-radv': 'Vulkan mit Mesa RADV. Stabilste Variante, für die meisten Modelle empfohlen.',
  'rocm-10.0': 'ROCm 10.0 (Fedora 44). Aktuellster stabiler ROCm-Zweig.',
  'rocm-7.14': 'ROCm 7.14 (Fedora 44). Vorgänger von 10.0, für den Fall dass 10.0 Probleme macht.',
  comfyui: 'ComfyUI mit ROCm-Torch für gfx1151 (Fedora rawhide). Bild- und Videogenerierung.',
}

/**
 * The known image tags, derived from the `Dockerfile.<tag>` files on disk.
 *
 * The directories are the most reliable source: the same lists are duplicated
 * in RUN_LLAMA_SERVER.md and the CI workflows, and reading the Dockerfiles
 * means a backend added upstream shows up after an app update with no code
 * change here.
 *
 * @returns {{tag: string, kind: string}[]}
 */
export function knownTags() {
  const found = []
  for (const { dir, kind } of SOURCES) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('Dockerfile.')) continue
        const tag = name.slice('Dockerfile.'.length)
        if (tag) found.push({ tag, kind })
      }
    } catch (err) {
      // One unreadable directory must not hide the other's images.
      log.warn(`${dir} nicht lesbar (${err.message}) — überspringe.`)
    }
  }
  const tags = found.length ? found : [...FALLBACK_TAGS]
  return tags.sort((a, b) => a.kind.localeCompare(b.kind) || a.tag.localeCompare(b.tag))
}

export function catalog() {
  return knownTags().map(({ tag, kind }) => ({
    tag,
    kind,
    ref: `${IMAGE_REPO}:${tag}`,
    description: DESCRIPTIONS[tag] ?? null,
  }))
}

/** Whether a reference points at a tag we know about. */
export function isKnownRef(ref) {
  return catalog().some((entry) => entry.ref === ref)
}

export { IMAGE_REPO }
