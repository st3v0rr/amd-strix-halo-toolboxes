import { LABEL, LABEL_VERSION, ROLE } from '../../../shared/constants.js'

/**
 * Ownership is recorded on the container itself rather than in our state file.
 *
 * That way a wiped state.json, a reboot, or a manual `podman start` never
 * leaves an orphan: whatever `podman ps` reports carries everything we need to
 * describe it. The API key is deliberately absent — it lives in profiles.json,
 * because a label is readable by every process of this user.
 */
export function buildLabels(spec) {
  return {
    [LABEL.managed]: 'true',
    [LABEL.version]: LABEL_VERSION,
    [LABEL.role]: spec.role ?? ROLE.server,
    [LABEL.profile]: spec.profileId ?? '',
    [LABEL.model]: spec.modelPath,
    [LABEL.image]: spec.image,
    [LABEL.ctx]: String(spec.ctxSize),
    [LABEL.gpuLayers]: String(spec.gpuLayers),
    [LABEL.threads]: String(spec.threads),
    [LABEL.port]: String(spec.hostPort),
    [LABEL.extraArgs]: spec.extraArgs ?? '',
    [LABEL.mmproj]: spec.mmprojPath ?? '',
    [LABEL.specType]: spec.specType ?? '',
    [LABEL.specDraftModel]: spec.specType ? (spec.specDraftModel ?? '') : '',
    [LABEL.specDraftNMax]: spec.specType ? String(spec.specDraftNMax ?? '') : '',
    [LABEL.rpcPeers]: (spec.rpcPeers ?? []).join(','),
    [LABEL.created]: new Date().toISOString(),
  }
}

/**
 * Labels for an RPC worker.
 *
 * The server-shaped fields (model, ctx, gpu layers, threads) have no meaning
 * here, and writing empty strings for them would make the UI show blanks where
 * it should show nothing. So the worker carries only what it actually has.
 */
export function buildRpcLabels(spec) {
  return {
    [LABEL.managed]: 'true',
    [LABEL.version]: LABEL_VERSION,
    [LABEL.role]: ROLE.rpc,
    [LABEL.image]: spec.image,
    [LABEL.port]: String(spec.hostPort),
    [LABEL.created]: new Date().toISOString(),
  }
}

/**
 * Labels for the media API container.
 *
 * What it was started with, so the detail pages can say where its models and
 * outputs live and how it is reachable, plus a hash of the whole run argv:
 * comparing that with the hash of what the current settings would produce is
 * how its detail page tells "running as configured" from "settings changed
 * since". Secrets are not in here — only the paths of the files holding them
 * are even in the argv.
 */
export function buildMediaLabels(spec) {
  return {
    [LABEL.managed]: 'true',
    [LABEL.version]: LABEL_VERSION,
    [LABEL.role]: ROLE.media,
    [LABEL.image]: spec.image,
    [LABEL.port]: String(spec.hostPort),
    [LABEL.bindAddress]: spec.bindAddress,
    [LABEL.mediaModelsDir]: spec.modelsDir,
    [LABEL.mediaModelsReadOnly]: spec.modelsReadOnly ? 'true' : 'false',
    [LABEL.mediaDataDir]: spec.dataDir,
    [LABEL.mediaBackend]: spec.backend,
    [LABEL.mediaDownloads]: spec.allowDownloads ? 'true' : 'false',
    [LABEL.specHash]: spec.specHash,
    [LABEL.created]: new Date().toISOString(),
  }
}

const KNOWN_ROLES = new Set([ROLE.rpc, ROLE.media])

/** Recover a server spec from a container's labels. */
export function parseLabels(labels = {}) {
  const num = (key, fallback) => {
    // An empty label is how an unset optional value is written, and
    // Number('') is 0 — which would turn "no draft limit" into an invalid one.
    if (labels[key] === undefined || labels[key] === '') return fallback
    const n = Number(labels[key])
    return Number.isFinite(n) ? n : fallback
  }
  const declaredRole = labels[LABEL.role]
  return {
    managed: labels[LABEL.managed] === 'true',
    // Containers created before the role label existed are llama-servers.
    // Defaulting rather than reporting null keeps them in the servers list.
    role: KNOWN_ROLES.has(declaredRole) ? declaredRole : ROLE.server,
    profileId: labels[LABEL.profile] || null,
    modelPath: labels[LABEL.model] || null,
    image: labels[LABEL.image] || null,
    ctxSize: num(LABEL.ctx, null),
    gpuLayers: num(LABEL.gpuLayers, null),
    threads: num(LABEL.threads, null),
    hostPort: num(LABEL.port, null),
    extraArgs: labels[LABEL.extraArgs] ?? '',
    // Null rather than '' so the UI can tell "no projector" from a server
    // created before this label existed — both simply show nothing.
    mmprojPath: labels[LABEL.mmproj] || null,
    specType: labels[LABEL.specType] || null,
    specDraftModel: labels[LABEL.specDraftModel] || null,
    specDraftNMax: num(LABEL.specDraftNMax, null),
    rpcPeers: (labels[LABEL.rpcPeers] || '').split(',').filter(Boolean),
    bindAddress: labels[LABEL.bindAddress] || null,
    mediaModelsDir: labels[LABEL.mediaModelsDir] || null,
    mediaModelsReadOnly: labels[LABEL.mediaModelsReadOnly] === undefined ? null : labels[LABEL.mediaModelsReadOnly] === 'true',
    mediaDataDir: labels[LABEL.mediaDataDir] || null,
    mediaBackend: labels[LABEL.mediaBackend] || null,
    mediaAllowDownloads: labels[LABEL.mediaDownloads] === undefined ? null : labels[LABEL.mediaDownloads] === 'true',
    specHash: labels[LABEL.specHash] || null,
    createdAt: labels[LABEL.created] || null,
  }
}

/** Filter argument that selects only containers this app created. */
export const managedFilter = `label=${LABEL.managed}=true`
