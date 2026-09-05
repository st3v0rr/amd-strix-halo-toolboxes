import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { del, get, post } from '../api/client.js'
import { PageHead } from '../components/Layout.jsx'
import { ConfirmDialog } from '../components/Modal.jsx'
import { useToast } from '../components/Toast.jsx'
import { shortImage } from '../components/format.js'
import { EMPTY_PROFILE, ProfileDialog } from './ProfileDialog.jsx'

export function Profiles() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)

  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => get('/profiles') })

  const launch = useMutation({
    mutationFn: (id) => post(`/profiles/${id}/launch`, {}),
    onSuccess: (result) => {
      toast.success(`Server '${result.name}' gestartet.`)
      queryClient.invalidateQueries({ queryKey: ['servers'] })
    },
    onError: (err) => toast.error(err),
  })

  const remove = useMutation({
    mutationFn: (id) => del(`/profiles/${id}`),
    onSuccess: () => {
      toast.success('Profil gelöscht.')
      setPendingDelete(null)
      queryClient.invalidateQueries({ queryKey: ['profiles'] })
    },
    onError: (err) => toast.error(err),
  })

  const list = profiles.data?.profiles ?? []

  return (
    <>
      <PageHead
        title="Profile"
        description="Gespeicherte Server-Konfigurationen. Mit Autostart werden sie nach einem Neustart der Box automatisch wieder hochgefahren."
      >
        <button className="btn btn-primary" type="button" onClick={() => setEditing(EMPTY_PROFILE)}>
          Profil anlegen
        </button>
      </PageHead>

      {profiles.isError ? (
        <div className="alert alert-danger">{profiles.error.message}</div>
      ) : list.length === 0 ? (
        <div className="empty">
          Noch kein Profil gespeichert. Ein Profil merkt sich Modell, Image, Port und alle
          Startparameter.
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Modell</th>
                <th>Image</th>
                <th>Port</th>
                <th>Autostart</th>
                <th aria-label="Aktionen" />
              </tr>
            </thead>
            <tbody>
              {list.map((profile) => (
                <tr key={profile.id}>
                  <td><strong>{profile.name}</strong></td>
                  <td className="small mono" style={{ maxWidth: 260 }}>
                    <span className="truncate" style={{ display: 'block' }} title={profile.modelPath}>
                      {profile.modelPath}
                    </span>
                    {profile.mmprojPath ? (
                      <span
                        className="truncate faint"
                        style={{ display: 'block' }}
                        title={profile.mmprojPath}
                      >
                        + {profile.mmprojPath}
                      </span>
                    ) : null}
                  </td>
                  <td className="small">{shortImage(profile.image)}</td>
                  <td className="small mono">{profile.port}</td>
                  <td>
                    {profile.autostart ? (
                      <span className="badge badge-ok">an</span>
                    ) : (
                      <span className="badge">aus</span>
                    )}
                  </td>
                  <td>
                    <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={launch.isPending}
                        onClick={() => launch.mutate(profile.id)}
                      >
                        Starten
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(profile)}>
                        Bearbeiten
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => setPendingDelete(profile)}
                      >
                        Löschen
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <ProfileDialog
          profile={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            queryClient.invalidateQueries({ queryKey: ['profiles'] })
          }}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Profil löschen"
          danger
          confirmLabel="Löschen"
          busy={remove.isPending}
          message={`Das Profil '${pendingDelete.name}' wird entfernt. Ein bereits laufender Container bleibt davon unberührt.`}
          onConfirm={() => remove.mutate(pendingDelete.id)}
          onClose={() => setPendingDelete(null)}
        />
      ) : null}
    </>
  )
}
