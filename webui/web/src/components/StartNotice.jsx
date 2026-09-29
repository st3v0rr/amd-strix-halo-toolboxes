import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { get } from '../api/client.js'
import { startNotice } from './startNotice.js'

/**
 * The one notice every start dialog shows, from the same server list the
 * Servers page polls: whether a container of this kind already runs, and — as
 * the thing that would actually make the start fail — whether the chosen host
 * port is taken.
 */
export function useStartNotice(choice) {
  const servers = useQuery({ queryKey: ['servers'], queryFn: () => get('/servers') })
  return startNotice(servers.data?.servers, choice)
}

/**
 * @param {object} props
 * @param {{running: object[], portTakenBy: object|null}} props.notice from useStartNotice
 * @param {number|string} props.port the chosen host port
 * @param {string|null} [props.conflictName] a container of the chosen name, once the server refused
 * @param {boolean} [props.replace]
 * @param {(value: boolean) => void} [props.onReplace] absent: this kind is never replaced directly
 * @param {() => void} props.onClose a link leaves the dialog
 */
export function StartNotice({ notice, port, conflictName, replace, onReplace, onClose }) {
  const link = (server) => (
    <Link to={`/servers/${encodeURIComponent(server.name)}`} onClick={onClose}>
      {server.name}
    </Link>
  )

  // What to do about a container of the chosen name: replace it here, or —
  // where that is not allowed — remove it on its own page first.
  const resolution = conflictName ? (
    onReplace ? (
      <label className="row">
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={Boolean(replace)}
          onChange={(e) => onReplace(e.target.checked)}
        />
        Vorhandenen Container stoppen, entfernen und neu anlegen
      </label>
    ) : (
      <span>
        Er wird nicht direkt ersetzt: {link({ name: conflictName })} öffnen, dort entfernen und
        danach neu starten.
      </span>
    )
  ) : null
  // A name clash with a running container belongs to the "läuft bereits" line
  // rather than to a second notice about the same container.
  const clashRunning = notice.running.some((s) => s.name === conflictName)

  return (
    <>
      {notice.portTakenBy ? (
        <div className="alert alert-danger small">
          <strong>Portkonflikt:</strong> Port {port} ist schon von {link(notice.portTakenBy)}{' '}
          belegt. Einen anderen Host-Port wählen.
        </div>
      ) : null}

      {notice.running.length > 0 ? (
        <div className={`alert small stack-sm ${clashRunning ? 'alert-warn' : 'alert-info'}`}>
          <span>
            Läuft bereits:{' '}
            {notice.running.map((server, i) => (
              <span key={server.name}>
                {i > 0 ? ', ' : ''}
                {link(server)}
                {server.hostPort ? ` (Port ${server.hostPort})` : ''}
              </span>
            ))}
          </span>
          {clashRunning ? resolution : null}
        </div>
      ) : null}

      {conflictName && !clashRunning ? (
        <div className="alert alert-warn small stack-sm">
          <span>
            Ein Container namens <code>{conflictName}</code> existiert bereits.
          </span>
          {resolution}
        </div>
      ) : null}
    </>
  )
}
