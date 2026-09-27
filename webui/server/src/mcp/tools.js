import {
  COMFY_PORT,
  JOB_FINISHED_STATUS,
  JOB_STATUS,
  JOB_TYPE,
  PORT_MAX,
  PORT_MIN,
  RPC_PORT,
  SPEC_TYPES,
} from '../../../shared/constants.js'
import { ToolError } from './protocol.js'

/**
 * Every tool the MCP endpoint offers.
 *
 * Each one is a call to the REST API the browser uses, made with the caller's
 * own token — so validation, the "model still in use" refusals and the
 * firewall's hands-off rules apply to an agent exactly as they apply to a
 * click. A tool here adds convenience (defaults from the settings, a profile
 * found by name, waiting for a job), never a second path around the API.
 *
 * `api(method, path, {query, body})` resolves to the parsed JSON body or
 * throws a ToolError carrying the API's message.
 */

/* ------------------------------ schema helpers ------------------------------ */

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra })
const bool = (description) => ({ type: 'boolean', description })
const obj = (properties = {}, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const port = (description, extra = {}) => int(description, { minimum: PORT_MIN, maximum: PORT_MAX, ...extra })
const name = str('Container-Name, z. B. "qwen3" oder "comfyui".')
const replace = bool('Einen vorhandenen Container gleichen Namens ersetzen. Standard: false.')
const image = (description) => str(description)

const READ = { readOnlyHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
/** Reaches Hugging Face or a registry — outside this box. */
const ONLINE_READ = { readOnlyHint: true, openWorldHint: true }
const ONLINE_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }

const enc = encodeURIComponent

/** The llama-server fields shared by starting a server and saving a profile. */
const llamaSpec = {
  image: image('Image-Referenz. Ohne Angabe: das Standard-Image aus den Einstellungen. list_images zeigt, was da ist.'),
  modelPath: str(
    'GGUF relativ zum Modellverzeichnis: das Feld "primary" einer Gruppe aus list_models (bei mehrteiligen Modellen die erste Shard-Datei).',
  ),
  port: port('Host-Port, unter dem llama-server erreichbar wird (im Container immer 11434).'),
  ctxSize: int('Kontextgröße in Tokens. Ohne Angabe: Standard aus den Einstellungen. estimate_vram hilft bei der Wahl.', {
    minimum: 256,
    maximum: 4_000_000,
  }),
  gpuLayers: int('GPU-Layer (-ngl). Ohne Angabe: Standard aus den Einstellungen, meist 999 = alle.', {
    minimum: 0,
    maximum: 9999,
  }),
  threads: int('CPU-Threads. Ohne Angabe: Standard aus den Einstellungen.', { minimum: 1, maximum: 512 }),
  mmprojPath: str('Vision-Projektor (mmproj-GGUF) für multimodale Modelle, relativ zum Modellverzeichnis.'),
  specType: str('Speculative Decoding. Braucht immer specDraftModel.', { enum: [...SPEC_TYPES] }),
  specDraftModel: str('Draft-Modell für Speculative Decoding, relativ zum Modellverzeichnis.'),
  specDraftNMax: int('--spec-draft-n-max, Standard von llama.cpp ist 3.', { minimum: 1, maximum: 64 }),
  apiKey: str('API-Key für llama-server. Ohne Angabe wird einer erzeugt und zurückgegeben.'),
  extraArgs: str(
    'Zusätzliche llama-server-Argumente. Leer lassen: dann werden Flash Attention und no-mmap passend zum Image automatisch gesetzt — das ist auf Strix Halo Pflicht.',
  ),
  rpcPeers: {
    type: 'array',
    items: { type: 'string' },
    maxItems: 32,
    description: 'RPC-Worker anderer Maschinen als "host:port", um ein Modell über mehrere Boxen zu verteilen. Müssen vorher laufen.',
  },
}

/* --------------------------------- helpers --------------------------------- */

async function settings(api) {
  return (await api('GET', '/settings')).settings
}

/** Fill what a person would leave at its default in the dialog. */
async function withServerDefaults(api, spec) {
  const s = await settings(api)
  return {
    image: s.defaultImage,
    ctxSize: s.defaultCtxSize,
    gpuLayers: s.defaultGpuLayers,
    threads: s.defaultThreads,
    ...spec,
  }
}

/** A profile by ID or by name — agents remember names, the API wants IDs. */
async function findProfile(api, ref) {
  const { profiles } = await api('GET', '/profiles')
  const profile = profiles.find((p) => p.id === ref) ?? profiles.find((p) => p.name === ref)
  if (!profile) {
    throw new ToolError(
      `Kein Profil '${ref}'. Vorhanden: ${profiles.map((p) => p.name).join(', ') || 'keine'}.`,
      { status: 404, code: 'not_found' },
    )
  }
  return profile
}

/** Log entries come out of the ring buffer as {seq, value}. */
const logLines = (logs, tail) => (logs ?? []).map((e) => e?.value ?? e).slice(-tail)

/** The monitor snapshot minus ten minutes of sparkline samples. */
function withoutHistory(snapshot) {
  const { history: _history, ...rest } = snapshot
  return rest
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------------------------- tools ---------------------------------- */

export const tools = [
  /* ------------------------------- overview ------------------------------- */
  {
    name: 'get_overview',
    title: 'Überblick',
    description:
      'Der beste Einstieg: Speicher, GPU, Auslastung, alle verwalteten Container (llama-server, RPC-Worker, ComfyUI) und laufende Jobs in einem Aufruf.',
    inputSchema: obj(),
    annotations: READ,
    async run(_args, api) {
      const [system, { servers }, { jobs }] = await Promise.all([
        api('GET', '/system'),
        api('GET', '/servers'),
        api('GET', '/jobs'),
      ])
      return {
        system: withoutHistory(system),
        servers,
        activeJobs: jobs.filter((j) => !JOB_FINISHED_STATUS.includes(j.status)),
      }
    },
  },
  {
    name: 'get_system_status',
    title: 'Systemstatus',
    description: 'Aktuelle Messwerte: CPU, RAM, GPU-Speicher (VRAM/GTT), Temperaturen, Platte, Container-Statistiken und der letzte Autostart-Lauf.',
    inputSchema: obj(),
    annotations: READ,
    run: async (_args, api) => withoutHistory(await api('GET', '/system')),
  },
  {
    name: 'get_system_info',
    title: 'Systeminformationen',
    description: 'Kernel, Boot-Parameter, Versionen von podman/python/hf/git/Node, Repository-Pfad und die Version dieser Anwendung.',
    inputSchema: obj(),
    annotations: READ,
    async run(_args, api) {
      const [info, version] = await Promise.all([api('GET', '/system/info'), api('GET', '/version')])
      return { ...info, app: version }
    },
  },
  {
    name: 'restart_webui',
    title: 'Webinterface neu starten',
    description:
      'Startet diesen Dienst neu (nur unter systemd). Laufende Container bleiben unberührt, laufende Downloads brechen ab und lassen sich danach mit resume_download fortsetzen. Die MCP-Verbindung ist für einige Sekunden weg.',
    inputSchema: obj(),
    annotations: DESTRUCTIVE,
    run: (_args, api) => api('POST', '/system/restart'),
  },

  /* -------------------------------- servers -------------------------------- */
  {
    name: 'list_servers',
    title: 'Container auflisten',
    description: 'Alle verwalteten Container mit Rolle (server, rpc, comfy), Status, Port, Modell und Image.',
    inputSchema: obj(),
    annotations: READ,
    run: (_args, api) => api('GET', '/servers'),
  },
  {
    name: 'get_server',
    title: 'Container-Details',
    description: 'Details zu einem Container, einschließlich aller Startparameter.',
    inputSchema: obj({ name }, ['name']),
    annotations: READ,
    run: ({ name }, api) => api('GET', `/servers/${enc(name)}`),
  },
  {
    name: 'get_server_health',
    title: 'Server-Gesundheit',
    description: 'Fragt den /health-Endpunkt eines llama-servers ab — zeigt, ob das Modell fertig geladen ist.',
    inputSchema: obj({ name }, ['name']),
    annotations: READ,
    run: ({ name }, api) => api('GET', `/servers/${enc(name)}/health`),
  },
  {
    name: 'get_server_logs',
    title: 'Container-Log',
    description: 'Die letzten Zeilen aus dem Log eines Containers. Erste Anlaufstelle, wenn ein Server nicht hochkommt.',
    inputSchema: obj({ name, tail: int('Anzahl Zeilen, Standard 200.', { minimum: 1, maximum: 5000 }) }, [
      'name',
    ]),
    annotations: READ,
    run: ({ name, tail = 200 }, api) => api('GET', `/servers/${enc(name)}/logs`, { query: { tail } }),
  },
  {
    name: 'create_llama_server',
    title: 'llama-server starten',
    description:
      'Erzeugt und startet einen llama-server-Container für ein GGUF-Modell. Nicht angegebene Werte kommen aus den Einstellungen. Die Antwort enthält den API-Key. Danach mit get_server_health prüfen, ob das Modell geladen ist. Für wiederkehrende Konfigurationen besser ein Profil anlegen (create_profile) und launch_profile nutzen.',
    inputSchema: obj({ name, ...llamaSpec, replace }, ['name', 'modelPath', 'port']),
    annotations: WRITE,
    async run({ replace = false, ...spec }, api) {
      return api('POST', '/servers', { body: { ...(await withServerDefaults(api, spec)), replace } })
    },
  },
  {
    name: 'create_rpc_worker',
    title: 'RPC-Worker starten',
    description:
      'Startet einen ggml-rpc-server, der die GPU dieser Box einem llama-server auf einer anderen Maschine leiht. Achtung: RPC kennt keine Authentifizierung — nur in vertrauenswürdigen Netzen, Port per add_firewall_rule auf das Cluster-Netz beschränken.',
    inputSchema: obj(
      {
        name,
        image: image('Image-Referenz, ein llama-server-Image (z. B. :vulkan-radv).'),
        port: port(`Host-Port, Standard ${RPC_PORT}.`),
        bindAddress: str('Adresse, auf der der Worker lauscht, z. B. die IP im Cluster-Netz. Standard: alle.'),
        replace,
      },
      ['name', 'image'],
    ),
    annotations: WRITE,
    run: (args, api) => api('POST', '/servers', { body: { role: 'rpc', ...args } }),
  },
  {
    name: 'create_comfyui',
    title: 'ComfyUI starten',
    description:
      'Startet ComfyUI als Container. Modell- und Ausgabeverzeichnis kommen aus den Einstellungen. ComfyUI kennt keine Anmeldung.',
    inputSchema: obj(
      {
        name,
        image: image('Image-Referenz, das ComfyUI-Image (Tag :comfyui).'),
        port: port(`Host-Port, Standard ${COMFY_PORT}.`),
        replace,
      },
      ['name', 'image'],
    ),
    annotations: WRITE,
    run: (args, api) => api('POST', '/servers', { body: { role: 'comfy', ...args } }),
  },
  ...['start', 'stop', 'restart'].map((action) => ({
    name: `${action}_server`,
    title: { start: 'Container starten', stop: 'Container stoppen', restart: 'Container neu starten' }[action],
    description: {
      start: 'Startet einen gestoppten, bereits angelegten Container wieder.',
      stop: 'Stoppt einen Container. Er bleibt angelegt und lässt sich mit start_server wieder starten; der Speicher wird frei.',
      restart: 'Startet einen Container neu, z. B. nach einem Absturz oder um den Speicher zu leeren.',
    }[action],
    inputSchema: obj({ name }, ['name']),
    annotations: action === 'start' ? WRITE : DESTRUCTIVE,
    run: ({ name }, api) => api('POST', `/servers/${enc(name)}/${action}`),
  })),
  {
    name: 'delete_server',
    title: 'Container löschen',
    description: 'Stoppt und entfernt einen Container. Modelldateien und Profile bleiben erhalten.',
    inputSchema: obj({ name }, ['name']),
    annotations: DESTRUCTIVE,
    run: ({ name }, api) => api('DELETE', `/servers/${enc(name)}`),
  },
  {
    name: 'get_rpc_cache',
    title: 'RPC-Cache anzeigen',
    description: 'Größe des Tensor-Caches eines RPC-Workers.',
    inputSchema: obj({ name }, ['name']),
    annotations: READ,
    run: ({ name }, api) => api('GET', `/servers/${enc(name)}/cache`),
  },
  {
    name: 'clear_rpc_cache',
    title: 'RPC-Cache leeren',
    description: 'Leert den Tensor-Cache eines RPC-Workers.',
    inputSchema: obj({ name }, ['name']),
    annotations: DESTRUCTIVE,
    run: ({ name }, api) => api('DELETE', `/servers/${enc(name)}/cache`),
  },
  {
    name: 'save_server_as_profile',
    title: 'Server als Profil speichern',
    description: 'Legt aus einem laufenden llama-server ein Profil mit denselben Einstellungen an.',
    inputSchema: obj(
      {
        name,
        profileName: str('Name des Profils. Standard: der Container-Name.'),
        autostart: bool('Profil beim Booten automatisch starten. Standard: false.'),
      },
      ['name'],
    ),
    annotations: WRITE,
    async run({ name, profileName, autostart = false }, api) {
      const { profile } = await api('GET', `/servers/${enc(name)}/profile-draft`)
      return api('POST', '/profiles', {
        body: { ...profile, name: profileName || profile.name, autostart },
      })
    },
  },

  /* -------------------------------- profiles -------------------------------- */
  {
    name: 'list_profiles',
    title: 'Profile auflisten',
    description: 'Gespeicherte llama-server-Konfigurationen, einschließlich Autostart-Markierung und API-Key.',
    inputSchema: obj(),
    annotations: READ,
    run: (_args, api) => api('GET', '/profiles'),
  },
  {
    name: 'create_profile',
    title: 'Profil anlegen',
    description: 'Speichert eine llama-server-Konfiguration unter einem Namen. Nicht angegebene Werte kommen aus den Einstellungen. Startet noch nichts — dafür launch_profile.',
    inputSchema: obj(
      {
        name: str('Profilname, zugleich der Container-Name beim Start.'),
        ...llamaSpec,
        autostart: bool('Beim Booten der Box automatisch starten. Standard: false.'),
      },
      ['name', 'modelPath', 'port'],
    ),
    annotations: WRITE,
    run: async (args, api) => api('POST', '/profiles', { body: await withServerDefaults(api, args) }),
  },
  {
    name: 'update_profile',
    title: 'Profil ändern',
    description: 'Ändert einzelne Felder eines Profils; alle anderen bleiben. Ein laufender Container übernimmt die Änderung erst mit launch_profile und replace=true.',
    inputSchema: obj(
      {
        profile: str('ID oder Name des Profils.'),
        name: str('Neuer Profilname.'),
        ...llamaSpec,
        autostart: bool('Beim Booten automatisch starten.'),
      },
      ['profile'],
    ),
    annotations: WRITE,
    async run({ profile: ref, ...patch }, api) {
      const { id, createdAt: _c, updatedAt: _u, ...current } = await findProfile(api, ref)
      return api('PUT', `/profiles/${enc(id)}`, { body: { ...current, ...patch } })
    },
  },
  {
    name: 'delete_profile',
    title: 'Profil löschen',
    description: 'Löscht ein Profil. Ein laufender Container dazu bleibt unberührt.',
    inputSchema: obj({ profile: str('ID oder Name des Profils.') }, ['profile']),
    annotations: DESTRUCTIVE,
    async run({ profile: ref }, api) {
      const { id } = await findProfile(api, ref)
      return api('DELETE', `/profiles/${enc(id)}`)
    },
  },
  {
    name: 'launch_profile',
    title: 'Profil starten',
    description: 'Startet den llama-server eines Profils. Mit replace=true wird ein vorhandener Container gleichen Namens ersetzt (nötig nach update_profile).',
    inputSchema: obj({ profile: str('ID oder Name des Profils.'), replace }, ['profile']),
    annotations: WRITE,
    async run({ profile: ref, replace = false }, api) {
      const { id } = await findProfile(api, ref)
      return api('POST', `/profiles/${enc(id)}/launch`, { body: { replace } })
    },
  },
  {
    name: 'run_autostart',
    title: 'Autostart ausführen',
    description: 'Startet sofort alle Profile mit Autostart, die gerade nicht laufen — dasselbe, was beim Booten passiert.',
    inputSchema: obj(),
    annotations: WRITE,
    run: (_args, api) => api('POST', '/profiles/reconcile'),
  },

  /* --------------------------------- models --------------------------------- */
  {
    name: 'list_models',
    title: 'GGUF-Modelle auflisten',
    description:
      'Alle GGUF-Modelle im Modellverzeichnis, nach Quantisierung gruppiert, dazu Vision-Projektoren und freier Plattenplatz. "key" dient zum Löschen, die Dateipfade (rel) zum Starten.',
    inputSchema: obj({ refresh: bool('Verzeichnis neu einlesen statt den Cache zu nutzen.') }),
    annotations: READ,
    run: ({ refresh }, api) => (refresh ? api('POST', '/models/refresh') : api('GET', '/models')),
  },
  {
    name: 'delete_model',
    title: 'Modell löschen',
    description:
      'Löscht ein Modell (alle Shards) bzw. einen Projektor von der Platte. Wird es von einem Server benutzt, schlägt das fehl — außer mit force=true, dann werden diese Server vorher gestoppt.',
    inputSchema: obj(
      {
        key: str('Der "key" einer Gruppe aus list_models oder der Pfad eines Projektors.'),
        force: bool('Server, die das Modell benutzen, vorher stoppen.'),
      },
      ['key'],
    ),
    annotations: DESTRUCTIVE,
    run: ({ key, force = false }, api) => api('DELETE', '/models', { query: { key, force: force || undefined } }),
  },
  {
    name: 'estimate_vram',
    title: 'Speicherbedarf schätzen',
    description:
      'Schätzt den GPU-Speicherbedarf eines Modells für eine oder mehrere Kontextgrößen. Die Box hat bis zu 124 GiB gemeinsamen Speicher.',
    inputSchema: obj(
      {
        path: str('GGUF relativ zum Modellverzeichnis: "primary" aus list_models.'),
        contexts: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          description: 'Kontextgrößen, z. B. [32768, 65536, 131072].',
        },
        overhead: { type: 'number', minimum: 0, maximum: 64, description: 'Zuschlag in GiB, Standard 2.' },
      },
      ['path'],
    ),
    annotations: READ,
    run: ({ path, contexts, overhead }, api) =>
      api('GET', '/models/estimate', { query: { path, contexts: contexts?.join(','), overhead } }),
  },
  {
    name: 'search_huggingface',
    title: 'Hugging Face durchsuchen',
    description: 'Sucht GGUF-Repositories auf Hugging Face.',
    inputSchema: obj(
      {
        query: str('Suchbegriff, z. B. "Qwen3 GGUF".'),
        limit: int('Höchstzahl Treffer, Standard 30.', { minimum: 1, maximum: 50 }),
      },
      ['query'],
    ),
    annotations: ONLINE_READ,
    run: ({ query, limit }, api) => api('GET', '/models/hf/search', { query: { q: query, limit } }),
  },
  {
    name: 'list_huggingface_files',
    title: 'Dateien eines HF-Repos',
    description: 'Listet die GGUF-Dateien eines Hugging-Face-Repositories, gruppiert nach Quantisierung, mit Größen.',
    inputSchema: obj(
      {
        repo: str('Repository, z. B. "unsloth/Qwen3-30B-A3B-GGUF".'),
        revision: str('Branch oder Commit, Standard "main".'),
      },
      ['repo'],
    ),
    annotations: ONLINE_READ,
    run: ({ repo, revision }, api) => api('GET', '/models/hf/files', { query: { repo, revision } }),
  },
  {
    name: 'download_model',
    title: 'Modell herunterladen',
    description:
      'Startet einen Download von Hugging Face als Hintergrund-Job. Bei mehrteiligen Modellen alle Shards angeben. Fortschritt mit get_job/wait_for_job verfolgen.',
    inputSchema: obj(
      {
        repo: str('Repository, z. B. "unsloth/Qwen3-30B-A3B-GGUF".'),
        include: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 500,
          description: 'Exakte Dateipfade ("path") aus list_huggingface_files — keine Muster.',
        },
        revision: str('Branch oder Commit, Standard "main".'),
        targetSubdir: str('Unterverzeichnis im Modellverzeichnis. Standard: aus dem Repo-Namen abgeleitet.'),
      },
      ['repo', 'include'],
    ),
    annotations: ONLINE_WRITE,
    run: (args, api) => api('POST', '/models/downloads', { body: args }),
  },
  {
    name: 'resume_download',
    title: 'Download fortsetzen',
    description: 'Setzt einen abgebrochenen, fehlgeschlagenen oder unterbrochenen Modell-Download fort. Bereits geladene Teile bleiben erhalten.',
    inputSchema: obj({ jobId: str('ID des alten Download-Jobs.') }, ['jobId']),
    annotations: ONLINE_WRITE,
    run: ({ jobId }, api) => api('POST', `/models/downloads/${enc(jobId)}/resume`),
  },

  /* --------------------------------- ComfyUI --------------------------------- */
  {
    name: 'list_comfy_models',
    title: 'ComfyUI-Modelle auflisten',
    description: 'Die Dateien im ComfyUI-Modellbaum (checkpoints, loras, vae, …) mit Größen und freiem Platz.',
    inputSchema: obj({ refresh: bool('Verzeichnis neu einlesen statt den Cache zu nutzen.') }),
    annotations: READ,
    run: ({ refresh }, api) =>
      refresh ? api('POST', '/comfy/models/refresh') : api('GET', '/comfy/models'),
  },
  {
    name: 'delete_comfy_model',
    title: 'ComfyUI-Modell löschen',
    description: 'Löscht eine Datei aus dem ComfyUI-Modellbaum. Geht nur, solange kein ComfyUI läuft.',
    inputSchema: obj({ rel: str('Pfad relativ zum ComfyUI-Modellverzeichnis, wie list_comfy_models ihn nennt.') }, ['rel']),
    annotations: DESTRUCTIVE,
    run: ({ rel }, api) => api('DELETE', '/comfy/models', { query: { rel } }),
  },
  {
    name: 'list_comfy_catalog',
    title: 'ComfyUI-Download-Katalog',
    description: 'Die Modellpakete (Workflows samt Gewichten), die das ComfyUI-Image herunterladen kann.',
    inputSchema: obj(),
    annotations: READ,
    run: (_args, api) => api('GET', '/comfy/catalog'),
  },
  {
    name: 'download_comfy_models',
    title: 'ComfyUI-Modelle herunterladen',
    description: 'Lädt ein Paket aus list_comfy_catalog als Hintergrund-Job herunter.',
    inputSchema: obj(
      {
        id: str('ID des Pakets aus list_comfy_catalog.'),
        image: image('Das ComfyUI-Image, dessen Download-Skript benutzt wird (Tag :comfyui).'),
      },
      ['id', 'image'],
    ),
    annotations: ONLINE_WRITE,
    run: (args, api) => api('POST', '/comfy/downloads', { body: args }),
  },
  {
    name: 'list_comfy_outputs',
    title: 'ComfyUI-Ergebnisse',
    description: 'Die zuletzt von ComfyUI erzeugten Bilder und Videos, neueste zuerst.',
    inputSchema: obj(),
    annotations: READ,
    run: (_args, api) => api('GET', '/comfy/outputs'),
  },

  /* --------------------------------- images --------------------------------- */
  {
    name: 'list_images',
    title: 'Images auflisten',
    description: 'Verfügbare Container-Images (llama-server-Backends wie vulkan-radv, rocm-10.0, und ComfyUI): lokal vorhanden oder nicht, Update verfügbar, erkannte Argumente.',
    inputSchema: obj(),
    annotations: READ,
    run: (_args, api) => api('GET', '/images'),
  },
  {
    name: 'pull_image',
    title: 'Image laden',
    description: 'Lädt ein Image bzw. dessen neueste Version als Hintergrund-Job. Laufende Container benutzen das neue Image erst nach replace.',
    inputSchema: obj({ ref: image('Image-Referenz aus list_images.') }, ['ref']),
    annotations: ONLINE_WRITE,
    run: ({ ref }, api) => api('POST', '/images/pull', { body: { ref } }),
  },
  {
    name: 'check_image_updates',
    title: 'Image-Updates prüfen',
    description: 'Fragt die Registry sofort nach neuen Builds aller Images.',
    inputSchema: obj(),
    annotations: ONLINE_READ,
    run: (_args, api) => api('POST', '/images/check-updates'),
  },
  {
    name: 'redetect_image_args',
    title: 'Image-Argumente neu erkennen',
    description: 'Ermittelt neu, wie das llama-server eines Images Flash Attention und no-mmap schreibt. Nur nötig, wenn Server mit einem Argumentfehler abbrechen.',
    inputSchema: obj({ ref: image('Image-Referenz.') }, ['ref']),
    annotations: WRITE,
    run: ({ ref }, api) => api('POST', '/images/redetect', { query: { ref } }),
  },
  {
    name: 'delete_image',
    title: 'Image löschen',
    description: 'Entfernt ein lokales Image. Schlägt fehl, solange ein Container es benutzt.',
    inputSchema: obj({ ref: image('Image-Referenz.') }, ['ref']),
    annotations: DESTRUCTIVE,
    run: ({ ref }, api) => api('DELETE', '/images', { query: { ref } }),
  },

  /* ---------------------------------- jobs ---------------------------------- */
  {
    name: 'list_jobs',
    title: 'Jobs auflisten',
    description: 'Hintergrund-Jobs: Downloads, Image-Pulls, Argumenterkennung, App-Updates. Neueste zuerst.',
    inputSchema: obj({
      type: str('Nur Jobs dieses Typs.', { enum: [...JOB_TYPE] }),
      status: str('Nur Jobs mit diesem Status.', { enum: [...JOB_STATUS] }),
    }),
    annotations: READ,
    run: ({ type, status }, api) => api('GET', '/jobs', { query: { type, status } }),
  },
  {
    name: 'get_job',
    title: 'Job-Details',
    description: 'Status, Fortschritt und die letzten Log-Zeilen eines Jobs.',
    inputSchema: obj(
      {
        id: str('Job-ID.'),
        logTail: int('Anzahl Log-Zeilen, Standard 50.', { minimum: 0, maximum: 2000 }),
      },
      ['id'],
    ),
    annotations: READ,
    async run({ id, logTail = 50 }, api) {
      const { job, logs } = await api('GET', `/jobs/${enc(id)}`)
      return { job, logs: logLines(logs, logTail) }
    },
  },
  {
    name: 'wait_for_job',
    title: 'Auf Job warten',
    description:
      'Wartet, bis ein Job fertig ist, höchstens timeoutSeconds lang, und gibt dann seinen Stand zurück. Bei langen Downloads mehrfach aufrufen.',
    inputSchema: obj(
      {
        id: str('Job-ID.'),
        // Clients abort a tool call after about 60 s by default.
        timeoutSeconds: int('Höchstens so lange warten, Standard 45.', { minimum: 1, maximum: 55 }),
      },
      ['id'],
    ),
    annotations: READ,
    async run({ id, timeoutSeconds = 45 }, api) {
      const deadline = Date.now() + timeoutSeconds * 1000
      for (;;) {
        const { job, logs } = await api('GET', `/jobs/${enc(id)}`)
        const finished = JOB_FINISHED_STATUS.includes(job.status)
        if (finished || Date.now() >= deadline) {
          return { finished, job, logs: logLines(logs, 20) }
        }
        await sleep(Math.min(2000, Math.max(0, deadline - Date.now())))
      }
    },
  },
  {
    name: 'cancel_job',
    title: 'Job abbrechen',
    description: 'Bricht einen laufenden oder wartenden Job ab bzw. entfernt einen fertigen aus der Liste.',
    inputSchema: obj({ id: str('Job-ID.') }, ['id']),
    annotations: DESTRUCTIVE,
    run: ({ id }, api) => api('DELETE', `/jobs/${enc(id)}`),
  },

  /* --------------------------------- network --------------------------------- */
  {
    name: 'get_network',
    title: 'Netzwerk und Firewall',
    description:
      'Netzwerkschnittstellen, firewalld-Status und welche Ports die verwalteten Dienste brauchen — offen, nur für bestimmte Netze freigegeben oder zu.',
    inputSchema: obj(),
    annotations: READ,
    run: (_args, api) => api('GET', '/network'),
  },
  {
    name: 'open_firewall_port',
    title: 'Port öffnen',
    description: 'Öffnet einen Port in firewalld für alle. Für RPC-Worker und ComfyUI (ohne Authentifizierung) lieber add_firewall_rule mit einem Quellnetz.',
    inputSchema: obj(
      { port: port('Port.'), protocol: str('Standard tcp.', { enum: ['tcp', 'udp'] }) },
      ['port'],
    ),
    annotations: WRITE,
    run: ({ port, protocol }, api) => api('POST', '/network/firewall/ports', { body: { port, protocol } }),
  },
  {
    name: 'close_firewall_port',
    title: 'Port schließen',
    description: 'Schließt einen Port in firewalld. Nur für Ports, die zu einem verwalteten Dienst gehören.',
    inputSchema: obj(
      { port: port('Port.'), protocol: str('Standard tcp.', { enum: ['tcp', 'udp'] }) },
      ['port'],
    ),
    annotations: DESTRUCTIVE,
    run: ({ port, protocol }, api) =>
      api('DELETE', '/network/firewall/ports', { query: { port, protocol } }),
  },
  {
    name: 'add_firewall_rule',
    title: 'Port für ein Netz freigeben',
    description: 'Gibt einen Port nur für ein Quellnetz frei (firewalld rich rule), z. B. den RPC-Port für das Cluster-Netz.',
    inputSchema: obj(
      {
        port: port('Port.'),
        protocol: str('Standard tcp.', { enum: ['tcp', 'udp'] }),
        source: str('Quelladresse oder Netz in CIDR-Schreibweise, z. B. "10.0.0.0/24".'),
      },
      ['port', 'source'],
    ),
    annotations: WRITE,
    run: (args, api) => api('POST', '/network/firewall/rules', { body: args }),
  },
  {
    name: 'remove_firewall_rule',
    title: 'Netzfreigabe entfernen',
    description: 'Entfernt eine rich rule. Den genauen Text liefert get_network unter ports[].sources[].raw.',
    inputSchema: obj({ rule: str('Die Regel im Wortlaut von firewalld.') }, ['rule']),
    annotations: DESTRUCTIVE,
    run: ({ rule }, api) => api('DELETE', '/network/firewall/rules', { query: { rule } }),
  },

  /* -------------------------------- settings -------------------------------- */
  {
    name: 'get_settings',
    title: 'Einstellungen lesen',
    description: 'Verzeichnisse, Standardwerte für neue Server, Download- und Image-Optionen. Der HF-Token wird nie ausgegeben, nur ob er gesetzt ist.',
    inputSchema: obj(),
    annotations: READ,
    run: (_args, api) => api('GET', '/settings'),
  },
  {
    name: 'update_settings',
    title: 'Einstellungen ändern',
    description: 'Ändert einzelne Einstellungen; nicht genannte bleiben. bindAddress und port wirken erst nach restart_webui.',
    inputSchema: obj({
      modelsDir: str('Absoluter Pfad des GGUF-Modellverzeichnisses.'),
      comfyModelsDir: str('Absoluter Pfad des ComfyUI-Modellbaums.'),
      comfyOutputDir: str('Absoluter Pfad für ComfyUI-Ausgaben.'),
      bindAddress: str('Adresse, auf der das Webinterface lauscht.'),
      port: port('Port des Webinterface.'),
      defaultImage: image('Standard-Image für neue Server.'),
      defaultCtxSize: int('Standard-Kontextgröße.', { minimum: 256, maximum: 4_000_000 }),
      defaultGpuLayers: int('Standard-GPU-Layer.', { minimum: 0, maximum: 9999 }),
      defaultThreads: int('Standard-Threads.', { minimum: 1, maximum: 512 }),
      maxConcurrentDownloads: int('Parallele Downloads.', { minimum: 1, maximum: 3 }),
      allowCustomImages: bool('Beliebige Image-Referenzen erlauben (Sicherheitsrisiko: Container bekommen /dev/kfd).'),
      imageCheckIntervalHours: int('Abstand der automatischen Image-Prüfung.', { minimum: 1, maximum: 168 }),
      useHfTransfer: bool('hf_transfer für Downloads verwenden.'),
      disableXet: bool('Xet abschalten, einfaches HTTPS erzwingen (hilft, wenn Downloads bei 0 % hängen).'),
      hfToken: str('Hugging-Face-Token für gated Repositories. Wird gespeichert, aber nie wieder ausgegeben.'),
    }),
    annotations: WRITE,
    run: (patch, api) => api('PUT', '/settings', { body: patch }),
  },
  {
    name: 'clear_hf_token',
    title: 'HF-Token entfernen',
    description: 'Entfernt den gespeicherten Hugging-Face-Token.',
    inputSchema: obj(),
    annotations: DESTRUCTIVE,
    run: (_args, api) => api('DELETE', '/settings/hf-token'),
  },

  /* --------------------------------- updates --------------------------------- */
  {
    name: 'get_app_update_status',
    title: 'App-Update-Status',
    description: 'Ob für diese Anwendung (das Git-Repository) ein Update bereitliegt, und das Log des letzten Updates.',
    inputSchema: obj(),
    annotations: READ,
    run: (_args, api) => api('GET', '/updates/app'),
  },
  {
    name: 'check_app_update',
    title: 'Nach App-Update suchen',
    description: 'Holt den neuesten Stand vom Git-Remote und vergleicht.',
    inputSchema: obj(),
    annotations: ONLINE_READ,
    run: (_args, api) => api('POST', '/updates/app/check'),
  },
  {
    name: 'apply_app_update',
    title: 'App-Update einspielen',
    description: 'Spielt das Update als Job ein und startet den Dienst danach neu. Laufende Container bleiben unberührt; die MCP-Verbindung ist kurz weg.',
    inputSchema: obj(),
    annotations: { ...DESTRUCTIVE, openWorldHint: true },
    run: (_args, api) => api('POST', '/updates/app/apply'),
  },
]

export const instructions = `Steuert eine AMD-Strix-Halo-Box (Ryzen AI Max, bis 124 GiB gemeinsamer Speicher für CPU und GPU): llama-server-Container für GGUF-Modelle, RPC-Worker für verteilte Inferenz, ComfyUI, die Modellverzeichnisse, Images, Firewall und Einstellungen.

Vorgehen:
- Mit get_overview beginnen.
- Modell starten: list_models → estimate_vram für die gewünschte Kontextgröße → create_llama_server (oder launch_profile) → get_server_health, bis das Modell geladen ist; bei Problemen get_server_logs.
- Modell besorgen: search_huggingface → list_huggingface_files → download_model → wait_for_job.
- Downloads, Image-Pulls und Updates laufen als Jobs im Hintergrund; der Aufruf kehrt sofort mit der Job-ID zurück.
- Flash Attention und no-mmap setzt die Box selbst; extraArgs normalerweise leer lassen.
- Fehlermeldungen kommen auf Deutsch und nennen meist den Ausweg (z. B. welcher Server ein Modell benutzt).`
