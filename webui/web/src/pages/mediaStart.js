/**
 * The media API start dialog as plain functions: stored settings → form, what
 * is wrong with a form, and form → the body POST /servers takes. Kept out of
 * the JSX so node:test can check them (web/test/mediaStart.test.js).
 */
import { NAME_RE, PORT_MAX, PORT_MIN, ROLE } from '../../../shared/constants.js'
import { isLoopbackAddress } from '../../../shared/media.js'

const LOOPBACK = '127.0.0.1'

/** Everything the dialog asks, seeded from the stored settings. */
export function mediaStartForm(config) {
  return {
    name: config.name,
    port: String(config.port),
    exposed: !isLoopbackAddress(config.bindAddress),
    autostart: Boolean(config.autostart),
  }
}

/**
 * Field → message for what the form can tell on its own; empty when it can be
 * sent. The server checks all of it again.
 *
 * @returns {Record<string, string>}
 */
export function mediaStartErrors(form) {
  const errors = {}
  if (!NAME_RE.test(form.name.trim())) errors.name = 'Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich.'
  const port = Number(form.port)
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
    errors.port = `Zwischen ${PORT_MIN} und ${PORT_MAX}.`
  }

  return errors
}

/**
 * The POST /servers body. API-key changes are deliberately not part of start:
 * a refused container operation must never rotate persisted credentials.
 *
 * "Im Netzwerk erreichbar" means every interface — unless the stored settings
 * already name one specific address (set through the API), which then stays.
 */
export function mediaStartBody(form, config) {
  const stored = config?.bindAddress ?? LOOPBACK
  const bindAddress = form.exposed ? (isLoopbackAddress(stored) ? '0.0.0.0' : stored) : LOOPBACK
  return {
    role: ROLE.media,
    name: form.name.trim(),
    port: Number(form.port),
    bindAddress,
    autostart: Boolean(form.autostart),
    replace: false,
  }
}
