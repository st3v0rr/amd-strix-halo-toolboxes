import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'

import { get } from '../api/client.js'

/**
 * Put the machine's hostname in the browser tab.
 *
 * One instance runs per box, so without this four tabs are indistinguishable —
 * exactly when you need to tell them apart, which is while wiring a cluster
 * together.
 *
 * The hostname goes first because a tab strip truncates from the right:
 * "strix-01 ·…" still identifies the machine, "Strix Halo…" does not. And
 * /api/version needs no session, so the tab is already labelled on the login
 * page.
 */
export function useDocumentTitle() {
  const version = useQuery({
    queryKey: ['version'],
    queryFn: () => get('/version'),
    retry: false,
  })

  const hostname = version.data?.hostname

  useEffect(() => {
    document.title = hostname ? `${hostname} · Strix Halo` : 'Strix Halo WebUI'
  }, [hostname])
}
