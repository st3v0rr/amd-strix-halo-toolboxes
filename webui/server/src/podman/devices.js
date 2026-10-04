import fs from 'node:fs'
import { conflict } from '../lib/errors.js'

/** Linux dev_t encoding (not simply rdev >> 8 on modern kernels). */
export function deviceIdentity(rdev) {
  const value = BigInt(rdev)
  return {
    major: Number(((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n)),
    minor: Number((value & 0xffn) | ((value >> 12n) & 0xffffff00n)),
  }
}

/**
 * Podman saves device numbers at create time. After a kernel upgrade inspect
 * can resolve the old number to an unrelated host node (e.g. ng0n1 -> kfd).
 * Never reconstruct a run spec from labels: they do not preserve all options.
 * Refuse without modifying the existing container or its persistent data.
 */
export function verifyGpuDevices(info, { required = true, stat = fs.statSync, read = fs.readFileSync } = {}) {
  const fail = (reason) => {
    throw conflict(
      `GPU-Geräte des Containers sind veraltet oder nicht prüfbar (${reason}). ` +
      'Container ausdrücklich mit der ursprünglichen Konfiguration neu anlegen; ein Neustart repariert gespeicherte Gerätezuordnungen nicht. ' +
      'Vorher Modell, Speculative/MTP-Optionen, Ports, Autostart und API-Schlüssel sichern. Es wurde nichts entfernt oder geändert.',
    )
  }
  if (!info) fail('Container-Inspect fehlt')
  const devices = info.HostConfig?.Devices
  const gpu = Array.isArray(devices)
    ? devices.filter((d) => d.PathInContainer === '/dev/kfd' || d.PathInContainer?.startsWith('/dev/dri/'))
    : []
  if (!required && gpu.length === 0) return
  if (!gpu.some((d) => d.PathInContainer === '/dev/kfd') ||
      !gpu.some((d) => d.PathInContainer?.startsWith('/dev/dri/'))) fail('KFD/DRI-Zuordnung fehlt')

  // OCI is the saved numeric identity, not just Podman's reverse-resolved path.
  let saved
  try {
    saved = JSON.parse(read(info.OCIConfigPath, 'utf8')).linux?.devices
  } catch {
    fail('gespeicherte OCI-Geräte nicht lesbar')
  }
  if (!Array.isArray(saved)) fail('gespeicherte OCI-Geräte fehlen')
  for (const mapping of gpu) {
    const destination = mapping.PathInContainer
    if (mapping.PathOnHost !== destination) fail(`${destination}: falscher Hostpfad`)
    let host
    try {
      host = stat(destination, { bigint: true })
    } catch {
      fail(`${destination}: Hostgerät fehlt`)
    }
    if (!host.isCharacterDevice()) fail(`${destination}: kein Zeichengerät`)
    const identity = deviceIdentity(host.rdev)
    const entries = saved.filter((d) => d.path === destination)
    if (entries.length !== 1 || entries[0].type !== 'c' ||
        entries[0].major !== identity.major || entries[0].minor !== identity.minor) {
      fail(`${destination}: gespeicherte Gerätenummer stimmt nicht mit dem Host überein`)
    }
  }
}
