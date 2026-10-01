import fs from 'node:fs'

import { IMAGE_REPO } from '../../../shared/constants.js'
import { dockerfileDir, mediaDockerfileDir } from '../config/paths.js'
import { log } from '../lib/log.js'

/**
 * Where the tags come from. Each directory holds `Dockerfile.<tag>` files, and
 * `kind` is what the images page uses to tell a llama-server backend from the
 * media API — unrelated software that merely shares a DockerHub repo.
 */
const SOURCES = [
  { dir: dockerfileDir, kind: 'llama' },
  { dir: mediaDockerfileDir, kind: 'media' },
]

/** Hard fallback if the repo layout is ever unreadable (e.g. tarball install). */
const FALLBACK_TAGS = [
  { tag: 'vulkan-radv', kind: 'llama' },
  { tag: 'rocm-10.0', kind: 'llama' },
  { tag: 'rocm-10.0-strix-llama', kind: 'llama' },
  { tag: 'media-api', kind: 'media' },
]

/** What each image does, in one style: stack and base, then its job. */
const DESCRIPTIONS = {
  'vulkan-radv': 'llama-server mit Vulkan (Mesa RADV) für gfx1151 (Fedora 44). LLM-Inferenz per OpenAI-kompatibler API.',
  'rocm-10.0': 'llama-server mit ROCm 10.0 für gfx1151 (Fedora 44). LLM-Inferenz per OpenAI-kompatibler API.',
  'rocm-10.0-strix-llama':
    'strix-llama.cpp mit eigener ROCm-Runtime für gfx1151 (Fedora 44). LLM-Inferenz per OpenAI-kompatibler API, experimentell.',
  'media-api':
    'Media API mit diffusers und ROCm-Torch für gfx1151 (Fedora rawhide). Bild- und Videogenerierung per API.',
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
