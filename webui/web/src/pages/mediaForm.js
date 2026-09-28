/**
 * The media API settings form, as plain functions: stored config → form state
 * (strings, so a limit can be empty), form state → the body PUT /media/config
 * takes, and what is wrong with a form before it is sent. Kept out of the JSX
 * so node:test can check it (web/test/mediaForm.test.js).
 */
import {
  MEDIA_LIMITS,
  isIpv4,
  parseOrigin,
  parsePublicUrl,
} from '../../../shared/media.js'
import { NAME_RE, PORT_MAX, PORT_MIN } from '../../../shared/constants.js'

const str = (v) => (v === null || v === undefined ? '' : String(v))

export function formFromConfig(config) {
  return {
    name: config.name,
    image: config.image,
    port: str(config.port),
    bindAddress: config.bindAddress,
    publicUrl: config.publicUrl ?? '',
    modelsDir: config.modelsDir ?? '',
    modelsReadOnly: Boolean(config.modelsReadOnly),
    dataDir: config.dataDir,
    backend: config.backend,
    allowDownloads: Boolean(config.allowDownloads),
    memoryCheck: config.memoryCheck,
    memoryReserveGb: str(config.memoryReserveGb),
    disableMmap: Boolean(config.disableMmap),
    logLevel: config.logLevel,
    cookieSecure: Boolean(config.cookieSecure),
    allowXApiKey: Boolean(config.allowXApiKey),
    corsOrigins: (config.corsOrigins ?? []).join('\n'),
    sessionTtlHours: str(config.sessionTtlHours),
    limits: Object.fromEntries(MEDIA_LIMITS.map((l) => [l.key, str(config.limits?.[l.key])])),
    autostart: Boolean(config.autostart),
  }
}

const origins = (text) =>
  String(text ?? '')
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter(Boolean)

const number = (text) => (String(text).trim() === '' ? null : Number(text))

/** The PUT body. Only call it on a form without errors. */
export function payloadFromForm(form) {
  return {
    name: form.name.trim(),
    image: form.image.trim(),
    port: Number(form.port),
    bindAddress: form.bindAddress.trim(),
    publicUrl: form.publicUrl.trim(),
    modelsDir: form.modelsDir.trim(),
    modelsReadOnly: form.modelsReadOnly,
    dataDir: form.dataDir.trim(),
    backend: form.backend,
    allowDownloads: form.allowDownloads,
    memoryCheck: form.memoryCheck,
    memoryReserveGb: Number(form.memoryReserveGb),
    disableMmap: form.disableMmap,
    logLevel: form.logLevel,
    cookieSecure: form.cookieSecure,
    allowXApiKey: form.allowXApiKey,
    corsOrigins: origins(form.corsOrigins).map((o) => parseOrigin(o) ?? o),
    sessionTtlHours: Number(form.sessionTtlHours),
    limits: Object.fromEntries(MEDIA_LIMITS.map((l) => [l.key, number(form.limits[l.key])])),
    autostart: form.autostart,
  }
}

const absolute = (p) => p.startsWith('/') && !/[:,]/.test(p)

/**
 * Field → message for everything the form can tell on its own. The server
 * checks all of it again, plus what only it knows (paths that exist, what
 * they overlap with).
 *
 * @returns {Record<string, string>}
 */
export function formErrors(form) {
  const errors = {}
  if (!NAME_RE.test(form.name.trim())) errors.name = 'Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.'
  if (!form.image.trim()) errors.image = 'Ein Image ist nötig.'
  const port = Number(form.port)
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    errors.port = `Zwischen ${PORT_MIN} und ${PORT_MAX}.`
  }
  if (!isIpv4(form.bindAddress.trim())) errors.bindAddress = 'Eine IPv4-Adresse, z. B. 127.0.0.1.'
  if (form.publicUrl.trim() && !parsePublicUrl(form.publicUrl)) {
    errors.publicUrl = 'Eine http(s)-Adresse ohne Zugangsdaten, z. B. https://media.box.lan.'
  }
  if (form.modelsDir.trim() && !absolute(form.modelsDir.trim())) {
    errors.modelsDir = 'Absoluter Pfad ohne „:“ und „,“ — oder leer für den ComfyUI-Modellbaum.'
  }
  if (!absolute(form.dataDir.trim())) errors.dataDir = 'Absoluter Pfad ohne „:“ und „,“.'
  if (form.allowDownloads && form.modelsReadOnly) {
    errors.allowDownloads = 'Downloads durch den Dienst brauchen einen beschreibbaren Modell-Mount.'
  }
  const reserve = Number(form.memoryReserveGb)
  if (String(form.memoryReserveGb).trim() === '' || !(reserve >= 0 && reserve <= 1024)) {
    errors.memoryReserveGb = 'Zwischen 0 und 1024.'
  }
  const ttl = Number(form.sessionTtlHours)
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 720) errors.sessionTtlHours = 'Ganze Stunden, 1 bis 720.'
  const badOrigin = origins(form.corsOrigins).find((o) => !parseOrigin(o))
  if (badOrigin) errors.corsOrigins = `„${badOrigin}“ ist keine http(s)-Origin (kein Pfad, kein „*“).`
  for (const limit of MEDIA_LIMITS) {
    const text = String(form.limits[limit.key] ?? '').trim()
    if (!text) continue
    const value = Number(text)
    if (!Number.isFinite(value) || value < limit.min || value > limit.max || (limit.int && !Number.isInteger(value))) {
      errors[`limits.${limit.key}`] = `${limit.int ? 'Ganzzahl' : 'Zahl'} von ${limit.min} bis ${limit.max}, oder leer.`
    }
  }
  return errors
}
