#!/usr/bin/env node
/**
 * Fixture shim for firewalld's client.
 *
 * Only the handful of calls the app makes, with the same exit codes and the
 * same terse output — including the polkit refusal, which is what a rootless
 * install really gets and the one branch that is otherwise impossible to try
 * out on a development machine.
 *
 * The open ports live in a JSON file so a change made through the UI is still
 * there on the next read, exactly as a real firewall would behave.
 *
 * Env:
 *   SHX_MOCK_FIREWALL=denied     every call fails the way polkit fails
 *   SHX_MOCK_FIREWALL=stopped    the daemon is installed but not running
 *   SHX_MOCK_FIREWALL_STATE=…    path to the JSON state file
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const mode = process.env.SHX_MOCK_FIREWALL || 'running'
const stateFile =
  process.env.SHX_MOCK_FIREWALL_STATE || path.join(process.cwd(), 'dev', 'tmp', 'firewalld.json')

if (mode === 'denied') {
  process.stderr.write(
    'Authorization failed.\nMake sure polkit agent is running or run the application as superuser.\n',
  )
  process.exit(1)
}

if (argv[0] === '--state') {
  if (mode === 'stopped') {
    process.stdout.write('not running\n')
    // firewalld's own code for "not running", which the app checks for.
    process.exit(252)
  }
  process.stdout.write('running\n')
  process.exit(0)
}

if (mode === 'stopped') {
  process.stderr.write('FirewallD is not running\n')
  process.exit(252)
}

function load() {
  const empty = { runtimeRules: [], permanentRules: [] }
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }
  } catch {
    // A box set up the way the README describes: the web interface open to
    // everyone, the RPC port only to the cluster's subnet.
    return {
      zone: 'FedoraServer',
      runtime: ['8420/tcp'],
      permanent: ['8420/tcp'],
      runtimeRules: [
        'rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" accept',
        'rule family="ipv4" source address="10.7.7.0/24" service name="cockpit" log prefix="cockpit" level="info" accept',
      ],
      permanentRules: [
        'rule family="ipv4" source address="10.7.7.0/24" port port="50052" protocol="tcp" accept',
        'rule family="ipv4" source address="10.7.7.0/24" service name="cockpit" log prefix="cockpit" level="info" accept',
      ],
    }
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
}

const state = load()
const permanent = argv.includes('--permanent')
const list = permanent ? 'permanent' : 'runtime'
const ruleList = permanent ? 'permanentRules' : 'runtimeRules'

if (argv.includes('--get-default-zone')) {
  process.stdout.write(`${state.zone}\n`)
  process.exit(0)
}

if (argv.includes('--list-ports')) {
  process.stdout.write(`${state[list].join(' ')}\n`)
  process.exit(0)
}

if (argv.includes('--list-rich-rules')) {
  // One per line, which is how firewalld prints them.
  process.stdout.write(state[ruleList].map((r) => `${r}\n`).join(''))
  process.exit(0)
}

const addRule = argv.find((a) => a.startsWith('--add-rich-rule='))
const removeRule = argv.find((a) => a.startsWith('--remove-rich-rule='))

if (addRule || removeRule) {
  const rule = (addRule ?? removeRule).slice((addRule ? '--add-rich-rule=' : '--remove-rich-rule=').length)
  if (addRule) {
    if (!state[ruleList].includes(rule)) state[ruleList].push(rule)
  } else {
    const index = state[ruleList].indexOf(rule)
    if (index === -1) {
      process.stderr.write(`Warning: NOT_ENABLED: ${rule}\n`)
      process.stdout.write('success\n')
      process.exit(0)
    }
    state[ruleList].splice(index, 1)
  }
  save(state)
  process.stdout.write('success\n')
  process.exit(0)
}

const add = argv.find((a) => a.startsWith('--add-port='))
const remove = argv.find((a) => a.startsWith('--remove-port='))

if (add) {
  const spec = add.split('=')[1]
  if (!state[list].includes(spec)) state[list].push(spec)
  save(state)
  process.stdout.write('success\n')
  process.exit(0)
}

if (remove) {
  const spec = remove.split('=')[1]
  const index = state[list].indexOf(spec)
  if (index === -1) {
    process.stderr.write(`Warning: NOT_ENABLED: ${spec}\nsuccess\n`)
    process.exit(0)
  }
  state[list].splice(index, 1)
  save(state)
  process.stdout.write('success\n')
  process.exit(0)
}

process.stderr.write(`mock firewall-cmd: unhandled ${argv.join(' ')}\n`)
process.exit(2)
