/**
 * The media API's rules, shared by the server (which enforces them) and the web
 * client (which checks while you type and builds the playground link).
 *
 * Free of Node built-ins and browser globals, like everything under shared/.
 * The key rules mirror toolboxes_media_api/src/media_api/config.py: a key the
 * webui accepts must be one the service accepts, or the container would exit 2
 * on start — and with `--restart unless-stopped`, keep doing so.
 */

/** Same list as PLACEHOLDER_KEYS in config.py: copied examples, not keys. */
export const MEDIA_PLACEHOLDER_KEYS = Object.freeze([
  'replace-with-a-long-random-key',
  'replace-with-a-different-long-random-secret',
  'changeme',
  'change-me',
  'example-key',
  'secret',
  'password',
])

/**
 * The models this project curates for the media API, as the image's registry
 * names them (toolboxes_media_api/src/media_api/data/models.yaml). The models
 * page and the fetch route offer these and nothing else, whatever an image
 * reports — with custom images allowed, that could be anything.
 */
export const MEDIA_MODEL_IDS = Object.freeze(['qwen-image-2512', 'qwen-image-edit-2511', 'minimax-h3'])

/** Only the curated entries of an inventory's model list, in its order. */
export function curatedMediaModels(models) {
  return (models ?? []).filter((m) => MEDIA_MODEL_IDS.includes(m?.id))
}

export const MEDIA_MIN_KEY_LENGTH = 16
export const MEDIA_MIN_SESSION_SECRET_LENGTH = 32
/** Longer than anyone types, short enough that a pasted file cannot sneak in. */
export const MEDIA_MAX_SECRET_LENGTH = 512

/**
 * Service limits the web interface can set. Each maps onto one MEDIA_* variable;
 * a limit left empty is not passed at all, so the service's own default applies
 * rather than a copy of it that could fall behind.
 */
export const MEDIA_LIMITS = Object.freeze([
  { key: 'maxQueuedJobs', env: 'MEDIA_MAX_QUEUED_JOBS', label: 'Wartende Aufträge', min: 1, max: 10_000, int: true },
  { key: 'maxUploadBytes', env: 'MEDIA_MAX_UPLOAD_BYTES', label: 'Upload-Größe (Bytes)', min: 1024, max: 512 * 1024 * 1024, int: true },
  { key: 'maxPromptChars', env: 'MEDIA_MAX_PROMPT_CHARS', label: 'Prompt-Länge (Zeichen)', min: 1, max: 100_000, int: true },
  { key: 'maxWidth', env: 'MEDIA_MAX_WIDTH', label: 'Breite (px)', min: 64, max: 8192, int: true },
  { key: 'maxHeight', env: 'MEDIA_MAX_HEIGHT', label: 'Höhe (px)', min: 64, max: 8192, int: true },
  { key: 'maxFrames', env: 'MEDIA_MAX_FRAMES', label: 'Video-Frames', min: 1, max: 2000, int: true },
  { key: 'maxSteps', env: 'MEDIA_MAX_STEPS', label: 'Schritte', min: 1, max: 1000, int: true },
  { key: 'resultTtlHours', env: 'MEDIA_RESULT_TTL_HOURS', label: 'Ergebnisse aufbewahren (h)', min: 0.01, max: 24 * 365, int: false },
  { key: 'maxRetainedJobs', env: 'MEDIA_MAX_RETAINED_JOBS', label: 'Aufbewahrte Aufträge', min: 1, max: 1_000_000, int: true },
])

export const MEDIA_MEMORY_CHECKS = Object.freeze(['strict', 'warn', 'off'])
export const MEDIA_LOG_LEVELS = Object.freeze(['critical', 'error', 'warning', 'info', 'debug'])
export const MEDIA_BACKENDS = Object.freeze(['real', 'mock'])

/**
 * Why a key would be refused, or null when it is fine.
 * @param {string} value
 */
export function checkMediaApiKey(value) {
  const key = String(value ?? '')
  if (!key) return 'Der Schlüssel ist leer.'
  if (/\s/.test(key)) return 'Der Schlüssel darf keine Leerzeichen oder Zeilenumbrüche enthalten.'
  if (MEDIA_PLACEHOLDER_KEYS.includes(key.toLowerCase())) {
    return 'Das ist der Platzhalter aus der Beispielkonfiguration, kein Schlüssel.'
  }
  if (key.length < MEDIA_MIN_KEY_LENGTH) return `Mindestens ${MEDIA_MIN_KEY_LENGTH} Zeichen.`
  if (key.length > MEDIA_MAX_SECRET_LENGTH) return `Höchstens ${MEDIA_MAX_SECRET_LENGTH} Zeichen.`
  return null
}

/**
 * The same for the session secret, which the service also requires to differ
 * from the key.
 */
export function checkMediaSessionSecret(value, apiKey) {
  const secret = String(value ?? '')
  if (MEDIA_PLACEHOLDER_KEYS.includes(secret.toLowerCase())) {
    return 'Das ist der Platzhalter aus der Beispielkonfiguration.'
  }
  if (secret.length < MEDIA_MIN_SESSION_SECRET_LENGTH) {
    return `Mindestens ${MEDIA_MIN_SESSION_SECRET_LENGTH} Zeichen.`
  }
  if (secret === apiKey) return 'Das Sitzungsgeheimnis muss sich vom API-Schlüssel unterscheiden.'
  return null
}

/** A dotted-quad IPv4 address without leading zeros, 0.0.0.0 included. */
export function isIpv4(value) {
  const parts = String(value ?? '').split('.')
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && !(p.length > 1 && p.startsWith('0')) && Number(p) <= 255)
  )
}

export function isLoopbackAddress(value) {
  const v = String(value ?? '').toLowerCase()
  return v === 'localhost' || v === '::1' || v === '[::1]' || /^127\./.test(v)
}

/**
 * A CORS origin as the service accepts it: http(s), a host, maybe a port —
 * nothing else. Returns the normalized origin, or null.
 */
export function parseOrigin(value) {
  const text = String(value ?? '').trim()
  if (!/^https?:\/\/[^/\s]+\/?$/i.test(text)) return null
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
  return url.origin
}

/**
 * The base URL of a reverse proxy in front of the service, as entered in the
 * settings: http(s), no credentials, no query. Returns it without a trailing
 * slash, or null.
 */
export function parsePublicUrl(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null
  if (url.username || url.password || url.search || url.hash) return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/**
 * Where the browser finds the playground, from the service's own settings —
 * never from anything a request carries — or why it cannot.
 *
 * The key never goes into the link: the playground has its own login form, and
 * a key in a URL ends up in browser history and proxy logs.
 *
 * @param {{publicUrl?: string, bindAddress?: string, port?: number}} config
 * @param {string} pageHostname the host the web interface itself was opened on
 * @returns {{url: string|null, remote: boolean, note: string|null}}
 */
export function mediaPlaygroundLink(config, pageHostname) {
  const port = Number(config?.port)
  const publicUrl = parsePublicUrl(config?.publicUrl)
  if (publicUrl) return { url: `${publicUrl}/ui/`, remote: true, note: null }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { url: null, remote: false, note: null }

  const bind = String(config?.bindAddress ?? '')
  const hostname = String(pageHostname ?? '')
  const bracket = (h) => (h.includes(':') && !h.startsWith('[') ? `[${h}]` : h)

  if (isLoopbackAddress(bind)) {
    if (isLoopbackAddress(hostname)) {
      return { url: `http://127.0.0.1:${port}/ui/`, remote: false, note: null }
    }
    return {
      url: null,
      remote: false,
      note:
        `Der Dienst ist nur an ${bind} gebunden und von diesem Browser aus nicht erreichbar. ` +
        `Per SSH-Tunnel (ssh -L ${port}:127.0.0.1:${port} <box>) öffnet sich die Oberfläche ` +
        `unter http://127.0.0.1:${port}/ui/ — oder einen TLS-Reverse-Proxy davorsetzen und seine ` +
        'Adresse als öffentliche URL eintragen.',
    }
  }

  const host = bind === '0.0.0.0' || bind === '' ? hostname : bind
  if (!host) return { url: null, remote: false, note: null }
  return {
    url: `http://${bracket(host)}:${port}/ui/`,
    remote: !isLoopbackAddress(host),
    note: isLoopbackAddress(host)
      ? null
      : 'Unverschlüsseltes HTTP: Schlüssel und Anmeldung gehen im Klartext über das Netz.',
  }
}

/**
 * How one profile of the inventory reads in the UI.
 *
 * @param {{status: string, available?: boolean, tasks_available?: Record<string, boolean>}} profile
 * @returns {{key: 'unsupported'|'ready'|'partial'|'missing', label: string, badge: string}}
 */
export function mediaProfileState(profile) {
  if (profile?.status === 'unsupported') {
    return { key: 'unsupported', label: 'nicht unterstützt', badge: '' }
  }
  if (profile?.available) return { key: 'ready', label: 'bereit', badge: 'badge-ok' }
  const tasks = Object.values(profile?.tasks_available ?? {})
  if (tasks.some(Boolean)) return { key: 'partial', label: 'teilweise', badge: 'badge-info' }
  return { key: 'missing', label: 'fehlt', badge: 'badge-warn' }
}

/**
 * What is worth a warning about a configuration that is nonetheless valid.
 * Refusals are the server's business; these are the trade-offs it lets through.
 *
 * @param {object} config a media config
 * @returns {{level: 'warn'|'danger', text: string}[]}
 */
export function mediaConfigWarnings(config) {
  const out = []
  if (/^https:/i.test(config.publicUrl ?? '') && !config.cookieSecure) {
    out.push({
      level: 'warn',
      text: 'Hinter einem HTTPS-Proxy sollte „Sitzungs-Cookie nur über HTTPS“ eingeschaltet sein.',
    })
  }
  if (config.allowDownloads) {
    out.push({
      level: 'warn',
      text:
        'Der Dienst lädt fehlende Modelle beim ersten Auftrag selbst und braucht dafür einen ' +
        'beschreibbaren Modell-Mount. Die Media API rät davon ab — besser über „Laden“ auf dieser Seite.',
    })
  } else if (config.modelsReadOnly === false) {
    out.push({
      level: 'warn',
      text: 'Der Modell-Mount ist beschreibbar, obwohl der Dienst nichts herunterladen darf.',
    })
  }
  if (config.backend === 'real' && config.memoryCheck === 'off') {
    out.push({
      level: 'warn',
      text: 'Ohne Speicherprüfung kann ein großes Modell neben llama-server die Box ins Swappen treiben.',
    })
  }
  if (config.backend === 'mock') {
    out.push({
      level: 'warn',
      text: 'Mock-Backend: keine GPU, keine Modelle — die Ergebnisse sind Testbilder.',
    })
  }
  return out
}

/** German names for the service's task ids. */
export const MEDIA_TASK_LABEL = Object.freeze({
  'text-to-image': 'Text → Bild',
  'image-edit': 'Bild bearbeiten',
  'text-to-video': 'Text → Video',
  'image-to-video': 'Bild → Video',
  'start-end-to-video': 'Start/Ende → Video',
  'reference-to-video': 'Referenz → Video',
})
