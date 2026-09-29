/**
 * What every start dialog says before anything is sent, as a plain function so
 * node:test can check it (web/test/startNotice.test.js): which containers of
 * the same kind already run, and whether the chosen host port is taken.
 *
 * Only running containers count. A stopped one holds no port, and its name —
 * if it collides — is the server's to report, since only the dialog knows
 * whether the user wants it replaced.
 *
 * @param {object[]} servers GET /servers
 * @param {{role: string, port: number|string, name?: string}} choice
 * @returns {{running: object[], portTakenBy: object|null}}
 */
export function startNotice(servers, { role, port, name }) {
  const up = (servers ?? []).filter((s) => s.running)
  const running = up.filter((s) => (s.role ?? 'server') === role)
  const wanted = Number(port)
  // The container of the same name is the one a replace would take down, so
  // its port is not in the way.
  const portTakenBy =
    Number.isInteger(wanted) && wanted > 0
      ? (up.find((s) => Number(s.hostPort) === wanted && s.name !== name) ?? null)
      : null
  return { running, portTakenBy }
}
