/**
 * How a voice pack's size is spelled for a reader.
 *
 * In `core/` because a capability's pane and a kernel sentence both say it, and a
 * capability reaches the kernel through its entry alone. See `inUnits` for why
 * there is one formatter.
 */

/**
 * Bytes in the unit a person reads them in.
 *
 * ⚠️ **ONE FORMATTER, BECAUSE TWO OF THEM HAD ALREADY DISAGREED.** This
 * sentence and the Voices pane both spell a pack's size, and they rounded in
 * different orders: at 1 023.6 MiB the notice said `1.0 GB` — it rounded to
 * whole megabytes FIRST, reaching exactly 1 024 — while the pane said
 * `1024 MB`. Nobody would have found that by reading either one.
 */
function inUnits(bytes: number): string {
  const mb = bytes / 1_048_576
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/**
 * A pack's SIZE, where a value that is not one is refused rather than drawn.
 *
 * ⚠️ **NOT `sizeOf`** — the public capability's `lib/bounds.ts` has one of
 * those, and it reads a Content-Length STRING into a number. Two FUNCTIONS of
 * that name answering different questions would have been worse than one.
 *
 * A row with no size would otherwise be offered as `NaN MB`, which is the
 * failure this exists for — a download of an unknown amount, described
 * confidently.
 */
export function packSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown size'
  return inUnits(bytes)
}

/**
 * How much has ARRIVED — where zero is a real answer and not a missing one.
 *
 * ⚠️ **`sizeOf` SAID "unknown size" FOR IT, AND A READER SAW THAT SENTENCE.**
 * Measured in the running app on 2026-09-23, pressing Download on the 2.3 GB
 * Chinese pack: the first line was *"Downloading · unknown size of 2.3 GB"*,
 * which reads as though the app has lost track of the download it has just
 * begun. `sizeOf` refuses zero deliberately — a catalogue row with no size
 * must not be offered as `NaN MB` — but a COUNT of bytes received starts at
 * zero every time, so it is the wrong function for this side of the sentence.
 */
export function packArrived(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  return inUnits(bytes)
}
