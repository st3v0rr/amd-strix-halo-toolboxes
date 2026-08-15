import { PORT_MAX, PORT_MIN } from '../../../shared/constants.js'
import { formatRichRule, parseRichRule, parseRichRules } from '../../../shared/firewall.js'
import { badRequest, failedDependency } from '../lib/errors.js'
import { run } from '../lib/exec.js'
import { log } from '../lib/log.js'

/**
 * firewalld, as much of it as this box needs.
 *
 * Two shapes only, and only in the default zone: a port open to everyone, and a
 * port open to one source network (a rich rule — see shared/firewall.js).
 * Everything else firewalld can do — services, logging, rejects, forwarding,
 * interface assignments — stays out of reach on purpose: this is a machine
 * whose firewall has to let three ports through, and a UI that can express the
 * whole of firewalld is a UI that can lock you out of it.
 *
 * Nothing here reloads the daemon. `firewall-cmd --reload` drops podman's own
 * forwarding rules, which leaves running containers unreachable until they are
 * restarted — a genuinely confusing failure. Instead every change is applied
 * twice: once to the running firewall, once to the permanent configuration.
 * Same end state, no reload.
 */

const TIMEOUT_MS = 10_000

/** firewalld's own exit code for "the daemon is not running". */
const NOT_RUNNING_EXIT = 252

/**
 * polkit's refusal, which is what a rootless install gets for anything that
 * touches the firewall. Not an error to shout about: the UI switches to
 * showing the commands to run by hand.
 */
function isAuthFailure(text) {
  return /authorization failed|not authorized|interactive authentication required/i.test(text ?? '')
}

async function firewallCmd(argv) {
  try {
    const { code, stdout, stderr } = await run('firewall-cmd', argv, {
      timeoutMs: TIMEOUT_MS,
      allowFailure: true,
    })
    return { ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err) {
    // A missing binary is a state, not a crash — the page says "no firewalld".
    if (err?.code === 'binary_missing') return { ok: false, missing: true, code: 127, stdout: '', stderr: '' }
    throw err
  }
}

/** `--list-ports` prints them space separated on one line: `8420/tcp 11434/tcp`. */
export function parsePorts(text) {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter((entry) => /^\d{1,5}\/(tcp|udp)$/i.test(entry))
    .map((entry) => entry.toLowerCase())
}

/**
 * What the firewall currently is: reachable, running, ours to change, and which
 * ports are open.
 *
 * Every field degrades on its own. A box without firewalld reports
 * `available: false` and the UI still lists which ports would need to be open;
 * a rootless install reports `permitted: false` and gets the commands instead
 * of buttons.
 */
export async function firewallStatus() {
  const state = await firewallCmd(['--state'])
  if (state.missing) {
    return {
      available: false,
      running: false,
      permitted: false,
      zone: null,
      ports: [],
      permanentPorts: [],
      richRules: [],
      foreignRichRules: [],
      reason: 'firewall-cmd wurde nicht gefunden — auf dieser Maschine läuft kein firewalld.',
    }
  }

  const output = `${state.stdout} ${state.stderr}`
  if (!state.ok && state.code === NOT_RUNNING_EXIT) {
    return {
      available: true,
      running: false,
      permitted: true,
      zone: null,
      ports: [],
      permanentPorts: [],
      richRules: [],
      foreignRichRules: [],
      reason: 'firewalld ist installiert, läuft aber nicht. Dann filtert es auch nichts.',
    }
  }
  if (!state.ok && isAuthFailure(output)) {
    return { ...deniedStatus(), running: true }
  }

  const zoneResult = await firewallCmd(['--get-default-zone'])
  if (!zoneResult.ok) {
    if (isAuthFailure(`${zoneResult.stdout} ${zoneResult.stderr}`)) return deniedStatus()
    return {
      available: true,
      running: true,
      permitted: false,
      zone: null,
      ports: [],
      permanentPorts: [],
      richRules: [],
      foreignRichRules: [],
      reason: zoneResult.stderr || 'Die Standardzone ließ sich nicht ermitteln.',
    }
  }

  const zone = zoneResult.stdout.split('\n')[0].trim()
  const [runtime, permanent, rich] = await Promise.all([
    firewallCmd([`--zone=${zone}`, '--list-ports']),
    firewallCmd(['--permanent', `--zone=${zone}`, '--list-ports']),
    firewallCmd([`--zone=${zone}`, '--list-rich-rules']),
  ])

  if (!runtime.ok && isAuthFailure(`${runtime.stdout} ${runtime.stderr}`)) return deniedStatus()

  const richRules = rich.ok ? parseRichRules(rich.stdout) : []

  return {
    available: true,
    running: true,
    permitted: runtime.ok,
    zone,
    ports: parsePorts(runtime.stdout),
    // Only these survive a reboot; a port open in one list and not the other is
    // worth showing rather than averaging away.
    permanentPorts: permanent.ok ? parsePorts(permanent.stdout) : [],
    // A port opened for one source only lives here rather than in `ports`,
    // which is why a firewall that looks closed can still be letting the
    // cluster through.
    richRules: richRules.filter((entry) => entry.parsed).map((entry) => entry.parsed),
    // Everything else in the zone: shown so the page does not pretend the
    // firewall consists of what it happens to understand.
    foreignRichRules: richRules.filter((entry) => !entry.parsed).map((entry) => entry.raw),
    reason: runtime.ok ? null : runtime.stderr || 'Die offenen Ports ließen sich nicht lesen.',
  }
}

function deniedStatus() {
  return {
    available: true,
    running: true,
    permitted: false,
    zone: null,
    ports: [],
    permanentPorts: [],
    richRules: [],
    foreignRichRules: [],
    reason:
      'firewalld verweigert den Zugriff. Das Webinterface läuft nicht als root — ' +
      'die Ports lassen sich hier anzeigen, aber nur von Hand öffnen.',
  }
}

function validate(port, protocol) {
  const number = Number(port)
  if (!Number.isInteger(number) || number < PORT_MIN || number > PORT_MAX) {
    throw badRequest(`Port ${port} liegt außerhalb von ${PORT_MIN}–${PORT_MAX}.`)
  }
  if (!['tcp', 'udp'].includes(protocol)) throw badRequest(`Unbekanntes Protokoll '${protocol}'.`)
  return `${number}/${protocol}`
}

/**
 * Open or close a port, in the running firewall and in the permanent
 * configuration.
 *
 * @param {'add'|'remove'} action
 */
async function changePort(action, port, protocol, zone) {
  const spec = validate(port, protocol)
  const status = await firewallStatus()
  if (!status.available) throw failedDependency(status.reason)
  if (!status.running) throw failedDependency(status.reason)
  if (!status.permitted) throw failedDependency(status.reason)

  const target = zone || status.zone
  const flag = `--${action}-port=${spec}`

  const runtime = await firewallCmd([`--zone=${target}`, flag])
  if (!runtime.ok) {
    throw failedDependency(
      `firewalld lehnte ${flag} ab: ${runtime.stderr || runtime.stdout || `exit ${runtime.code}`}`,
    )
  }

  const permanent = await firewallCmd(['--permanent', `--zone=${target}`, flag])
  if (!permanent.ok) {
    // The running firewall already changed, so this is a warning rather than a
    // failure — but the user has to know it will not survive a reboot.
    log.warn(`Dauerhafte Firewall-Regel ${flag} schlug fehl: ${permanent.stderr}`)
    return { spec, zone: target, permanent: false }
  }

  log.info(`Firewall: ${flag} in Zone ${target}`)
  return { spec, zone: target, permanent: true }
}

/**
 * Open a port for one source network only, as a rich rule.
 *
 * The whole reason this exists: the RPC port must not be open to the network,
 * but it must be open to the other machines in the cluster.
 *
 * @param {{port: number, protocol?: string, source: string, zone?: string|null}} spec
 */
export async function addRichRule({ port, protocol = 'tcp', source, zone = null }) {
  const rule = formatRichRule({ port, protocol, source })
  if (!rule) {
    throw badRequest(
      `'${source}' ist keine IPv4-Adresse und kein Netz in CIDR-Schreibweise ` +
        `(z. B. 10.7.7.0/24), oder Port ${port}/${protocol} ist nicht zulässig.`,
    )
  }
  return applyRichRule('add', rule, zone)
}

/**
 * Remove a rich rule, given exactly the text firewalld printed for it.
 *
 * Only rules this app can parse in full are accepted — a rule that also logs,
 * rejects or names a service is one whose consequences we cannot state, and
 * removing it blind is how somebody loses their SSH access.
 */
export async function removeRichRule({ raw, zone = null }) {
  const parsed = parseRichRule(raw)
  if (!parsed) {
    throw badRequest(
      'Diese Regel hat eine Form, die diese Anwendung nicht vollständig versteht. ' +
        'Sie wird deshalb nur angezeigt — entfernen mit: ' +
        `firewall-cmd --permanent --remove-rich-rule='${String(raw ?? '').trim()}'`,
    )
  }
  validate(parsed.port, parsed.protocol)
  return applyRichRule('remove', parsed.raw, zone)
}

async function applyRichRule(action, rule, zone) {
  const status = await firewallStatus()
  if (!status.available || !status.running || !status.permitted) {
    throw failedDependency(status.reason)
  }

  const target = zone || status.zone
  // One argv element, quotes and all. There is no shell in between, so the
  // rule reaches firewalld exactly as written here.
  const flag = `--${action}-rich-rule=${rule}`

  const runtime = await firewallCmd([`--zone=${target}`, flag])
  if (!runtime.ok) {
    throw failedDependency(
      `firewalld lehnte die Regel ab: ${runtime.stderr || runtime.stdout || `exit ${runtime.code}`}`,
    )
  }

  const permanent = await firewallCmd(['--permanent', `--zone=${target}`, flag])
  if (!permanent.ok) {
    log.warn(`Dauerhafte Rich Rule schlug fehl: ${permanent.stderr}`)
    return { rule, zone: target, permanent: false }
  }

  log.info(`Firewall: ${action} rich rule in Zone ${target} — ${rule}`)
  return { rule, zone: target, permanent: true }
}

export const openPort = (port, protocol = 'tcp', zone = null) =>
  changePort('add', port, protocol, zone)

export const closePort = (port, protocol = 'tcp', zone = null) =>
  changePort('remove', port, protocol, zone)
