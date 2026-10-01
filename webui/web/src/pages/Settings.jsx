import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { MIN_PASSWORD_LENGTH, USERNAME_RE } from '../../../shared/constants.js'
import { del, get, post, put } from '../api/client.js'
import { useAuth } from '../auth/AuthContext.jsx'
import { PageHead } from '../components/Layout.jsx'
import { formatDate } from '../components/format.js'
import { useToast } from '../components/Toast.jsx'

export function Settings() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['settings'], queryFn: () => get('/settings') })

  const [form, setForm] = useState(null)
  const [hfToken, setHfToken] = useState('')

  useEffect(() => {
    if (data?.settings) setForm(data.settings)
  }, [data])

  const clearToken = useMutation({
    mutationFn: () => del('/settings/hf-token'),
    onSuccess: (result) => {
      toast.success(result.wasSet ? 'Token entfernt.' : 'Es war kein Token gesetzt.')
      setHfToken('')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast.error(err),
  })

  const save = useMutation({
    mutationFn: (patch) => put('/settings', patch),
    onSuccess: () => {
      toast.success('Einstellungen gespeichert.')
      setHfToken('')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast.error(err),
  })

  if (isLoading || !form) {
    return (
      <>
        <PageHead title="Einstellungen" />
        <div className="empty">Wird geladen …</div>
      </>
    )
  }

  const field = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  const num = (key) => (e) => field(key, Number(e.target.value))

  function onSubmit(event) {
    event.preventDefault()
    const patch = { ...form }
    if (hfToken.trim()) patch.hfToken = hfToken.trim()
    save.mutate(patch)
  }

  return (
    <>
      <PageHead
        title="Einstellungen"
        description="Modellverzeichnis, Standardwerte für neue Server und Zugangsdaten."
      />

      <form className="stack" onSubmit={onSubmit}>
        <section className="card stack">
          <h2>Pfade und Netzwerk</h2>
          <div className="form-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="modelsDir">Modellverzeichnis</label>
              <input
                id="modelsDir"
                type="text"
                value={form.modelsDir}
                onChange={(e) => field('modelsDir', e.target.value)}
              />
              <span className="hint">
                Absoluter Pfad auf dem Host. Wird in den Containern nach /workspace/models
                gemountet.
              </span>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="mediaModelsDir">Media-Modellverzeichnis</label>
              <input
                id="mediaModelsDir"
                type="text"
                value={form.mediaModelsDir ?? ''}
                onChange={(e) => field('mediaModelsDir', e.target.value)}
              />
              <span className="hint">
                Eigener Baum der Media API mit diffusion_models, text_encoders, loras und so weiter —
                getrennt von den GGUFs. Wird nach /models gemountet, sofern die Media API kein
                eigenes Verzeichnis eingestellt hat.
              </span>
            </div>
            <div className="field">
              <label htmlFor="bindAddress">Bind-Adresse</label>
              <input
                id="bindAddress"
                type="text"
                value={form.bindAddress}
                onChange={(e) => field('bindAddress', e.target.value)}
              />
              <span className="hint">Erst nach einem Neustart des Dienstes wirksam.</span>
            </div>
            <div className="field">
              <label htmlFor="port">Port</label>
              <input id="port" type="number" value={form.port} onChange={num('port')} />
              <span className="hint">Erst nach einem Neustart des Dienstes wirksam.</span>
            </div>
          </div>
        </section>

        <section className="card stack">
          <h2>Standardwerte für neue Server</h2>
          <div className="form-grid">
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="defaultImage">Image</label>
              <input
                id="defaultImage"
                type="text"
                value={form.defaultImage}
                onChange={(e) => field('defaultImage', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="defaultCtxSize">Context Size</label>
              <input
                id="defaultCtxSize"
                type="number"
                value={form.defaultCtxSize}
                onChange={num('defaultCtxSize')}
              />
            </div>
            <div className="field">
              <label htmlFor="defaultGpuLayers">GPU Layers</label>
              <input
                id="defaultGpuLayers"
                type="number"
                value={form.defaultGpuLayers}
                onChange={num('defaultGpuLayers')}
              />
            </div>
            <div className="field">
              <label htmlFor="defaultThreads">Threads</label>
              <input
                id="defaultThreads"
                type="number"
                value={form.defaultThreads}
                onChange={num('defaultThreads')}
              />
            </div>
          </div>
        </section>

        <section className="card stack">
          <h2>Downloads und Images</h2>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="maxConcurrentDownloads">Parallele Downloads</label>
              <input
                id="maxConcurrentDownloads"
                type="number"
                min="1"
                max="3"
                value={form.maxConcurrentDownloads}
                onChange={num('maxConcurrentDownloads')}
              />
              <span className="hint">
                Netz und Platte sind der Flaschenhals — mehr als einer bringt selten etwas.
              </span>
            </div>
            <div className="field">
              <label htmlFor="imageCheckIntervalHours">Image-Prüfung (Stunden)</label>
              <input
                id="imageCheckIntervalHours"
                type="number"
                min="1"
                max="168"
                value={form.imageCheckIntervalHours}
                onChange={num('imageCheckIntervalHours')}
              />
            </div>
          </div>

          <label className="row small">
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.useHfTransfer}
              onChange={(e) => field('useHfTransfer', e.target.checked)}
            />
            hf_transfer verwenden (schneller, aber der Fortschritt ist gröber)
          </label>

          <label className="row small">
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.allowCustomImages}
              onChange={(e) => field('allowCustomImages', e.target.checked)}
            />
            Beliebige Image-Referenzen erlauben
          </label>
          {form.allowCustomImages ? (
            <div className="alert alert-warn small">
              Container erhalten <code>/dev/kfd</code> und <code>seccomp=unconfined</code>. Bei einem
              eigenen Media-API-Image vertraust du außerdem dessen Registry-Profilen vollständig:
              Modellprüfung und Downloads führen den Code und die Downloadquellen dieses Images aus.
              Nutze das nur für Images, denen du vertraust.
            </div>
          ) : null}
        </section>

        <section className="card stack">
          <h2>Hugging Face</h2>
          <div className="field">
            <label htmlFor="hfToken">Zugriffstoken</label>
            <div className="row">
              <input
                id="hfToken"
                className="grow"
                type="password"
                autoComplete="off"
                placeholder={
                  data.hfToken.configured
                    ? `gesetzt (${data.hfToken.hint}) — zum Ändern neu eingeben`
                    : 'nicht gesetzt'
                }
                value={hfToken}
                onChange={(e) => setHfToken(e.target.value)}
              />
              {data.hfToken.configured ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={clearToken.isPending}
                  onClick={() => clearToken.mutate()}
                >
                  {clearToken.isPending ? 'Entfernt …' : 'Token entfernen'}
                </button>
              ) : null}
            </div>
            <span className="hint">
              Nur für gated Repositories nötig. Wird gespeichert, aber nie wieder ausgegeben.
            </span>
          </div>

          <label className="row small">
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.disableXet}
              onChange={(e) => field('disableXet', e.target.checked)}
            />
            Xet-Übertragung deaktivieren (einfaches HTTPS erzwingen)
          </label>
          <span className="hint">
            Mit gesetztem Token laufen Downloads über Xet. Bleibt ein Download bei 0 % stehen,
            behebt diese Option das meist — der Token bleibt für gated Repositories nutzbar.
          </span>
        </section>

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={save.isPending}>
            {save.isPending ? 'Wird gespeichert …' : 'Speichern'}
          </button>
        </div>
      </form>

      <McpCard apiToken={data.apiToken} />

      <ServiceCard />

      <AccountCard username={data.username} />
    </>
  )
}

/**
 * Username and password in one form: both are proven by the same current
 * password, so splitting them would mean typing it twice to change both.
 */
function AccountCard({ username }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const { refresh } = useAuth()

  const [name, setName] = useState(username ?? '')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')

  // Adopt the stored name once it arrives, without discarding an edit.
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched && username) setName(username)
  }, [username, touched])

  const nameChanged = name.trim() !== '' && name.trim() !== username
  const passwordChanged = next.length > 0
  const mismatch = passwordChanged && repeat !== next
  const tooShort = passwordChanged && next.length < MIN_PASSWORD_LENGTH
  const nameInvalid = nameChanged && !USERNAME_RE.test(name.trim())

  const canSubmit =
    current.length > 0 && (nameChanged || passwordChanged) && !mismatch && !tooShort && !nameInvalid

  const save = useMutation({
    mutationFn: () => {
      const body = { currentPassword: current }
      if (nameChanged) body.username = name.trim()
      if (passwordChanged) body.newPassword = next
      return post('/auth/account', body)
    },
    onSuccess: async (result) => {
      toast.success(`${result.changed.join(' und ')} geändert.`)
      setCurrent('')
      setNext('')
      setRepeat('')
      setTouched(false)
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      await refresh()
    },
    onError: (err) => toast.error(err),
  })

  return (
    <section className="card stack">
      <div>
        <h2>Konto</h2>
        <p className="small muted">
          Benutzername und Passwort ändern. Andere angemeldete Sitzungen werden dabei
          abgemeldet.
        </p>
      </div>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
      >
        <div className="field">
          <label htmlFor="acc-name">Benutzername</label>
          <input
            id="acc-name"
            type="text"
            autoComplete="username"
            value={name}
            onChange={(e) => {
              setTouched(true)
              setName(e.target.value)
            }}
          />
          {nameInvalid ? (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              Erlaubt sind Buchstaben, Ziffern und . _ - @ + (max. 64 Zeichen, keine
              Leerzeichen).
            </span>
          ) : null}
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor="acc-next">Neues Passwort</label>
            <input
              id="acc-next"
              type="password"
              autoComplete="new-password"
              placeholder="leer lassen, um es zu behalten"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            {tooShort ? (
              <span className="hint" style={{ color: 'var(--danger)' }}>
                Mindestens {MIN_PASSWORD_LENGTH} Zeichen.
              </span>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="acc-repeat">Neues Passwort wiederholen</label>
            <input
              id="acc-repeat"
              type="password"
              autoComplete="new-password"
              disabled={!passwordChanged}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
            {mismatch ? (
              <span className="hint" style={{ color: 'var(--danger)' }}>
                Die Passwörter stimmen nicht überein.
              </span>
            ) : null}
          </div>
        </div>

        <div className="field">
          <label htmlFor="acc-current">Aktuelles Passwort zur Bestätigung</label>
          <input
            id="acc-current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>

        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={!canSubmit || save.isPending}>
            {save.isPending ? 'Wird gespeichert …' : 'Konto ändern'}
          </button>
          {!nameChanged && !passwordChanged ? (
            <span className="small faint">Nichts geändert.</span>
          ) : null}
        </div>
      </form>

      <p className="small faint">
        Zugang verloren? Auf der Box: <code>webui/scripts/shx-passwd --generate</code> setzt ein
        neues Passwort, <code>--username &lt;name&gt;</code> den Benutzernamen.
      </p>
    </section>
  )
}

/**
 * The token that lets Claude Desktop, Hermes Agent or any other MCP client run
 * the box. Shown once, right after it is issued — the server keeps only a
 * hash, so the snippets below can carry the real token only in that moment.
 */
function McpCard({ apiToken }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [fresh, setFresh] = useState(null)
  const [client, setClient] = useState('claude-desktop')

  const issue = useMutation({
    mutationFn: () => post('/settings/api-token'),
    onSuccess: (result) => {
      setFresh(result.token)
      toast.success(result.replaced ? 'Neuer Token erzeugt, der alte gilt nicht mehr.' : 'Token erzeugt.')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast.error(err),
  })

  const revoke = useMutation({
    mutationFn: () => del('/settings/api-token'),
    onSuccess: () => {
      setFresh(null)
      toast.success('Token widerrufen. MCP-Clients kommen nicht mehr herein.')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (err) => toast.error(err),
  })

  const url = `${window.location.origin}/mcp`
  const token = fresh ?? '<API-Token>'

  return (
    <section className="card stack">
      <div>
        <h2>MCP-Zugang</h2>
        <p className="small muted">
          Unter <code>{url}</code> spricht diese Box das Model Context Protocol. Ein Agent wie
          Claude Desktop oder Hermes Agent kann damit alles, was diese Oberfläche kann: Server
          starten und stoppen, Modelle laden und löschen, Firewall und Einstellungen ändern.
          Nur Benutzername, Passwort und diesen Token selbst kann er nicht anfassen.
        </p>
      </div>

      <div className="row wrap">
        {apiToken?.configured ? (
          <span className="small">
            Token <code>{apiToken.hint}</code>, erzeugt {formatDate(apiToken.createdAt)}
          </span>
        ) : (
          <span className="small faint">Kein Token — der MCP-Endpunkt lehnt jede Anfrage ab.</span>
        )}
      </div>

      <div className="row wrap">
        <button
          type="button"
          className="btn btn-primary"
          disabled={issue.isPending}
          onClick={() => issue.mutate()}
        >
          {apiToken?.configured ? 'Neuen Token erzeugen' : 'Token erzeugen'}
        </button>
        {apiToken?.configured ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            Token widerrufen
          </button>
        ) : null}
        {apiToken?.configured && !fresh ? (
          <span className="small faint">Ein neuer Token ersetzt den alten sofort.</span>
        ) : null}
      </div>

      {fresh ? (
        <div className="alert alert-warn small stack-sm">
          <span>
            Dieser Token wird nur jetzt angezeigt. Wer ihn hat, steuert die Box — behandle ihn
            wie ein Passwort.
          </span>
          <div className="row">
            <input
              className="grow mono"
              type="text"
              readOnly
              value={fresh}
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => navigator.clipboard?.writeText(fresh)}
            >
              Kopieren
            </button>
          </div>
        </div>
      ) : null}

      <div className="stack-sm">
        <div className="row wrap">
          {Object.entries(MCP_CLIENTS).map(([key, entry]) => (
            <button
              key={key}
              type="button"
              className={`btn btn-sm${client === key ? ' btn-primary' : ''}`}
              onClick={() => setClient(key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span className="hint">{MCP_CLIENTS[client].where}</span>
        <pre className="snippet">{MCP_CLIENTS[client].snippet(url, token)}</pre>
        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => navigator.clipboard?.writeText(MCP_CLIENTS[client].snippet(url, token))}
          >
            Kopieren
          </button>
          {!fresh ? (
            <span className="small faint">
              Den Platzhalter ersetzen — oder einen neuen Token erzeugen, dann steht er hier schon drin.
            </span>
          ) : null}
        </div>
      </div>
    </section>
  )
}

const MCP_CLIENTS = {
  'claude-desktop': {
    label: 'Claude Desktop',
    where:
      'In claude_desktop_config.json (Einstellungen → Entwickler → Konfiguration bearbeiten), dann Claude Desktop neu starten. Braucht Node.js auf dem Rechner; mcp-remote übersetzt zwischen Claude Desktop und diesem Endpunkt.',
    snippet: (url, token) =>
      JSON.stringify(
        {
          mcpServers: {
            'strix-halo': {
              command: 'npx',
              args: ['-y', 'mcp-remote', url, '--allow-http', '--header', 'Authorization:${SHX_AUTH}'],
              env: { SHX_AUTH: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
  },
  hermes: {
    label: 'Hermes Agent',
    where: 'In ~/.hermes/config.yaml, danach Hermes neu starten.',
    snippet: (url, token) =>
      `mcp_servers:\n  strix-halo:\n    url: "${url}"\n    headers:\n      Authorization: "Bearer ${token}"\n`,
  },
  'claude-code': {
    label: 'Claude Code',
    where: 'Im Terminal ausführen.',
    snippet: (url, token) =>
      `claude mcp add --transport http strix-halo ${url} \\\n  --header "Authorization: Bearer ${token}"`,
  },
}

/** Restart the service from the browser — the counterpart to systemctl restart. */
function ServiceCard() {
  const toast = useToast()
  const [restarting, setRestarting] = useState(false)

  const restart = useMutation({
    mutationFn: () => post('/system/restart'),
    onSuccess: (result) => {
      setRestarting(true)
      if (result.interruptedJobs?.length) {
        toast.info(`Neustart läuft. Abgebrochen: ${result.interruptedJobs.join(', ')}`)
      } else {
        toast.success('Neustart läuft …')
      }
      waitForService().then(() => window.location.reload())
    },
    onError: (err) => toast.error(err),
  })

  return (
    <section className="card stack">
      <div>
        <h2>Dienst</h2>
        <p className="small muted">
          Startet die Anwendung neu. Laufende llama.cpp-Container sind davon nicht betroffen —
          ein laufender Download bricht ab und lässt sich danach fortsetzen.
        </p>
      </div>
      <div className="row">
        <button
          type="button"
          className="btn"
          disabled={restart.isPending || restarting}
          onClick={() => restart.mutate()}
        >
          {restarting ? 'Startet neu …' : 'Dienst neu starten'}
        </button>
        {restarting ? (
          <span className="small faint">Die Seite lädt neu, sobald der Dienst wieder antwortet.</span>
        ) : null}
      </div>
    </section>
  )
}

/** Poll until the service answers again, then give up after two minutes. */
async function waitForService(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  // Give it a moment to actually go down, or the first probe hits the old
  // process and reports success immediately.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  while (Date.now() < deadline) {
    try {
      await get('/health')
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  return false
}
