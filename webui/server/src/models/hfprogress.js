/**
 * Reads progress out of the `hf download` output.
 *
 * This is the second of two progress sources. The primary one counts bytes in
 * the target directory, which is precise and immune to any change in the CLI's
 * output — but it assumes files grow where they will finally live. With Xet
 * storage (the default for many GGUF repos, unsloth included) that assumption
 * breaks: chunks land in a deduplicating cache under ~/.cache/huggingface/xet
 * and the file is materialised in one go at the end. The target directory then
 * stays empty for the whole download and the bar sits at 0 % until it jumps to
 * 100 %.
 *
 * So both sources are read and the larger wins.
 *
 * The percentage is taken from tqdm rather than its byte figures: tqdm's
 * human-readable sizes depend on a unit divisor that has changed between
 * huggingface_hub versions, while the percentage is exact. Multiplied by the
 * file size we already know from the API, it gives a trustworthy byte count.
 */

/** `<desc>:  12%|▏   | 48.2MB/397MB [00:01<00:07, 44.5MB/s]` */
const TQDM_RE = /^(?<desc>.*?):\s*(?<pct>\d{1,3})%\|(?<bar>[^|]*)\|\s*(?<nums>\S+\/\S+)?/

/** `48.2MB/397MB` — only counts when both sides carry a byte unit. */
const BYTES_RE =
  /^(?<done>[\d.]+)\s*(?<du>[kKMGTP]?i?B)\s*\/\s*(?<total>[\d.]+)\s*(?<tu>[kKMGTP]?i?B)$/

const UNITS = {
  B: 1,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  PB: 1000 ** 5,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
  PIB: 1024 ** 5,
}

export function toBytes(value, unit) {
  const factor = UNITS[String(unit).toUpperCase()] ?? 1
  return Math.round(Number(value) * factor)
}

export class HfProgress {
  /**
   * @param {{path: string, size: number}[]} files the selection, with exact
   *        sizes from the Hugging Face API
   */
  constructor(files = []) {
    /** basename -> exact size */
    this.sizeByName = new Map()
    for (const file of files) {
      this.sizeByName.set(file.path.split('/').pop(), file.size ?? 0)
    }
    this.totalBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0)
    this.fileCount = files.length
    /** basename (or bar description) -> bytes done */
    this.doneByName = new Map()
    this.xet = false
  }

  /**
   * Feed one output line.
   * @returns {boolean} whether it changed the tally
   */
  push(rawLine) {
    const line = String(rawLine ?? '').trim()
    if (!line) return false

    if (/xet storage is enabled/i.test(line)) this.xet = true

    const match = TQDM_RE.exec(line)
    if (!match) return false

    const desc = match.groups.desc.trim()
    const pct = Number(match.groups.pct)
    if (!Number.isFinite(pct)) return false

    // A known filename is the reliable case: percentage times the size the API
    // reported for exactly that file.
    const size = this.sizeByName.get(desc)
    if (size !== undefined) {
      this.doneByName.set(desc, Math.min(size, Math.round((pct / 100) * size)))
      return true
    }

    // Unknown description: only trust it if the counters carry byte units, so
    // a file-count bar ("Fetching 2 files: 50%|…| 1/2") cannot be mistaken for
    // bytes.
    const nums = match.groups.nums
    if (!nums) return false
    const bytes = BYTES_RE.exec(nums)
    if (!bytes) return false

    this.doneByName.set(
      desc,
      Math.min(
        toBytes(bytes.groups.total, bytes.groups.tu),
        toBytes(bytes.groups.done, bytes.groups.du),
      ),
    )
    return true
  }

  /** Bytes downloaded according to the CLI's own reporting. */
  get doneBytes() {
    let sum = 0
    for (const done of this.doneByName.values()) sum += done
    return Math.min(this.totalBytes || Infinity, sum)
  }
}
