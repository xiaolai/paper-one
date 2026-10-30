/**
 * The faces a book can be set in: what is offered, and what a size means in one.
 *
 * TWO PROBLEMS LIVE HERE, and they are the same problem seen twice.
 *
 * The first: a point size is not a size. Two faces at 21px do not look the same
 * size, because what the eye reads is the x-height and every face has its own —
 * measured in this app, Crimson Pro's was 42 per 100 against Literata's 51, so
 * choosing it made a reader's book 18% smaller with the size control untouched.
 * They then raised the step to compensate, which changed their MEASURE too,
 * since every step carries its own. `opticalScale` corrects the size by the
 * face's own x-height so a step means the same apparent size in all of them.
 *
 * The second: the app shipped four bundled faces and offered nothing a reader's
 * own machine already has, some of which are better for reading than anything
 * worth downloading — Iowan Old Style and Charter on macOS, Cambria and
 * Constantia on Windows. They are OFFERED ONLY WHEN PRESENT: a list naming a
 * face the reader does not have is a list that lies, and font availability
 * cannot be assumed from the platform.
 */

/**
 * What a reader is choosing between.
 *
 * NOT where the face came from. Nothing in what is shown says "bundled" or
 * "system", and there is no entry called "System serif": a reader choosing what
 * to read in does not care whether a font arrived with the app or with their
 * operating system, and cannot act on the answer. Every row is a font's own
 * name, set in that font. Where it came from is this file's business.
 */
export type FaceGroup = 'serif' | 'sans' | 'mono'

export interface Face {
  readonly id: string
  readonly label: string
  readonly group: FaceGroup
  /** The CSS stack the book is set in. */
  readonly stack: string
  /**
   * The family to look for on this machine, or absent for a face that ships
   * with the app and is therefore always there.
   */
  readonly probe?: string
}

/** The reference x-height, per 1em: Literata's, the app's default face. */
const REFERENCE_X_HEIGHT = 0.51

/**
 * How far a corrected size may travel from the size asked for.
 *
 * A face with an unusual x-height should be nudged, not rescaled — past this a
 * reader's "21" would produce something they would not recognise as 21, and a
 * broken measurement (a face that fails to load, a canvas that returns zero)
 * would produce something absurd rather than something slightly off.
 */
const SCALE_BOUNDS = { min: 0.86, max: 1.18 } as const

/** Always offered: bundled with the app, identical on every machine. */
const BUNDLED: readonly Face[] = [
  {
    id: 'literata',
    label: 'Literata',
    group: 'serif',
    stack: "'Literata Variable', Literata, 'Charis SIL', Georgia, serif",
  },
  {
    id: 'instrument',
    label: 'Instrument Sans',
    group: 'sans',
    stack: "'Instrument Sans Variable', 'Instrument Sans', system-ui, sans-serif",
  },
  {
    id: 'plex',
    label: 'IBM Plex Mono',
    group: 'mono',
    stack: "'IBM Plex Mono', ui-monospace, Menlo, monospace",
  },
]

/* THERE ARE NO GENERIC ENTRIES. `ui-serif`, `system-ui` and `ui-monospace`
 * resolve to real, distinct faces — on macOS `ui-serif` is New York, measured
 * here as its own face rather than a fallback — but they cannot be NAMED, and a
 * row reading "System serif" tells a reader nothing they can act on. The
 * keywords stay where they belong: at the tail of each stack, as the fallback
 * nobody sees. What is offered by name is offered by name.
 */

/**
 * Named faces worth reading in, in preference order, offered when found.
 *
 * NOT GATED ON THE PLATFORM, probed instead. Georgia is on macOS as well as
 * Windows; a Linux machine may have any of these or none. Asking the machine
 * what it has is both simpler than a platform table and correct in the cases a
 * platform table gets wrong.
 */
const NAMED: readonly Face[] = [
  // Serif, best first. Iowan Old Style and Charter ship with macOS and are
  // designed for continuous reading; Cambria and Constantia are Windows'
  // equivalents; the last three are the common Linux packagings.
  { id: 'iowan', label: 'Iowan Old Style', group: 'serif', stack: "'Iowan Old Style', serif", probe: 'Iowan Old Style' },
  { id: 'charter', label: 'Charter', group: 'serif', stack: "Charter, 'Bitstream Charter', serif", probe: 'Charter' },
  { id: 'cambria', label: 'Cambria', group: 'serif', stack: 'Cambria, serif', probe: 'Cambria' },
  { id: 'constantia', label: 'Constantia', group: 'serif', stack: 'Constantia, serif', probe: 'Constantia' },
  { id: 'palatino', label: 'Palatino', group: 'serif', stack: "Palatino, 'Palatino Linotype', serif", probe: 'Palatino' },
  { id: 'noto-serif', label: 'Noto Serif', group: 'serif', stack: "'Noto Serif', serif", probe: 'Noto Serif' },
  { id: 'georgia', label: 'Georgia', group: 'serif', stack: 'Georgia, serif', probe: 'Georgia' },

  { id: 'avenir', label: 'Avenir Next', group: 'sans', stack: "'Avenir Next', sans-serif", probe: 'Avenir Next' },
  { id: 'segoe', label: 'Segoe UI', group: 'sans', stack: "'Segoe UI', sans-serif", probe: 'Segoe UI' },
  { id: 'helvetica', label: 'Helvetica Neue', group: 'sans', stack: "'Helvetica Neue', sans-serif", probe: 'Helvetica Neue' },

  { id: 'menlo', label: 'Menlo', group: 'mono', stack: 'Menlo, monospace', probe: 'Menlo' },
  { id: 'consolas', label: 'Consolas', group: 'mono', stack: 'Consolas, monospace', probe: 'Consolas' },
]

/** The faces that ship with the app, and are therefore offerable anywhere. */
export const BUNDLED_FACES: readonly Face[] = BUNDLED

/** Every face the app knows of, whether or not this machine has it. */
export const ALL_FACES: readonly Face[] = [...BUNDLED, ...NAMED]

/** How many NAMED system faces to offer per group — see `offeredFaces`. */
const NAMED_PER_GROUP = 2

export const GROUP_LABEL: Record<FaceGroup, string> = {
  serif: 'Serif, for reading',
  sans: 'Sans',
  mono: 'Monospaced',
}

/** A face by id, or the default when the id is not one this build knows. */
export function faceById(id: string): Face {
  return ALL_FACES.find((face) => face.id === id) ?? (BUNDLED[0] as Face)
}

/**
 * The list to show, given what this machine turned out to have.
 *
 * Bundled first because it is guaranteed, then the platform's own, then at most
 * `NAMED_PER_GROUP` found faces in preference order. The cap is the whole point
 * of "a minimal set": a Mac has seven of the serifs above and a list of seven
 * serifs is not a choice, it is a font menu.
 */
export function offeredFaces(present: ReadonlySet<string>): readonly Face[] {
  const out: Face[] = []
  for (const group of ['serif', 'sans', 'mono'] as const) {
    out.push(...BUNDLED.filter((f) => f.group === group))
    out.push(
      ...NAMED.filter((f) => f.group === group && present.has(f.id)).slice(0, NAMED_PER_GROUP),
    )
  }
  return out
}

/**
 * The size correction for a face, from its own x-height.
 *
 * 1 when the x-height cannot be measured — no DOM, a face that has not loaded,
 * a canvas that returns nothing. Uncorrected is the behaviour this replaces and
 * is never worse than it; a wrong correction would be.
 */
export function scaleFor(xHeight: number): number {
  if (!Number.isFinite(xHeight) || xHeight <= 0) return 1
  const scale = REFERENCE_X_HEIGHT / xHeight
  return Math.min(SCALE_BOUNDS.max, Math.max(SCALE_BOUNDS.min, scale))
}
