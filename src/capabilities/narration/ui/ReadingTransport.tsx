import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
  type LucideIcon,
} from 'lucide-react'
import { CAPABILITY_UI as ui, ICON } from '../../../kernel'
import { READING_RATE, READING_RATE_MIN } from '../lib/settings'
import type { Speech } from './useSpeech'

export interface ReadingTransportProps {
  readonly speech: Speech
  readonly rate: number
  readonly onRate: (rate: number) => void
}

/**
 * The reading's controls, drawn where the Listen control was.
 *
 * ⚠️ **IT REPLACES THE CONTROL RATHER THAN FLOATING OVER THE PAGE**, which is the
 * choice that keeps the book at full height and puts nothing over the text. The
 * cost is width, and it is paid by the title chip, which shrinks — so every
 * control here is `--control-xs`, the design system's "an icon and nothing
 * else", rather than the titlebar size a bar button uses.
 *
 * ⚠️ **THE CHAPTER BUTTONS ARE ABSENT, NOT DISABLED, WHERE THE BOOK CANNOT STEP
 * CHAPTERS.** `SurfacePaging.chapter` is optional because a reader can be in a
 * spine item no contents entry points at, and there is genuinely no next chapter
 * to go to. A disabled control says "not now"; an absent one says "not here",
 * and the second is the true statement.
 */
export function ReadingTransport({ speech, rate, onRate }: ReadingTransportProps) {
  const step = (label: string, Icon: LucideIcon, run: () => void) => (
    <button
      type="button"
      className={`${ui.barButton} ${ui.transportButton}`}
      title={label}
      aria-label={label}
      onClick={run}
    >
      <Icon size={ICON.window} strokeWidth={ICON.stroke} />
    </button>
  )

  /* One control in both views: see the preparing view for why it is there too. */
  const pauseOrGoOn = (
    <button
      type="button"
      className={`${ui.barButton} ${ui.transportButton}`}
      title={speech.paused ? 'Go on reading' : 'Pause'}
      aria-label={speech.paused ? 'Go on reading' : 'Pause'}
      aria-pressed={speech.paused}
      onClick={() => (speech.paused ? speech.resume() : speech.pause())}
    >
      {speech.paused ? (
        <Play size={ICON.window} strokeWidth={ICON.stroke} />
      ) : (
        <Pause size={ICON.window} strokeWidth={ICON.stroke} />
      )}
    </button>
  )

  /**
   * A section being made into audio.
   *
   * ⚠️ **"MAKING" AND NOT "LOADING", AND THE WORD IS THE WHOLE POINT.** WI-34.0
   * measured a real section at 315 s on an idle M4 Max. Nothing is arriving over
   * a wire — the machine is synthesising a voice — so calling it buffering would
   * be a lie about a five-minute wait. WI-34.5 asks for that sentence to be
   * written honestly, and asks for the stop beside it, because a wait a reader
   * cannot leave is worse than a wait they can.
   *
   * ⚠️ **AND IT SAYS THE WAIT IS WORTH IT ONCE.** A reader who stops during a
   * render and presses Listen again gets it at once: the render finishes into the
   * store whether or not anybody is listening, which is a promise the transport
   * can make because `staging`-then-rename-then-checkpoint makes it true.
   *
   * ⚠️ **AND PAUSE STAYS, BECAUSE THIS VIEW IS NOT ONLY A LONG WAIT.** A chapter
   * the store already holds is "prepared" for the 25–270 ms it takes to read the
   * clip, so a reader pressing Pause as one chapter ran into the next found no
   * Pause there at all (`2026-11-01-d4-pause-closed.md`). The speaker honours a
   * pause before its first sample, so the control means the same thing here.
   */
  if (speech.preparing) {
    return (
      <div className={ui.transport} role="group" aria-label="Reading aloud">
        <span className={ui.preparing} role="status">
          Making this chapter’s audio…
        </span>
        {pauseOrGoOn}
        {step('Stop reading aloud', Square, () => speech.stop())}
      </div>
    )
  }

  return (
    <div className={ui.transport} role="group" aria-label="Reading aloud">
      {speech.chapters.back ? step('Previous chapter', ChevronsLeft, () => speech.stepChapter(-1)) : null}
      {step('Previous paragraph', SkipBack, () => speech.stepParagraph(-1))}
      {step('Previous sentence', ChevronLeft, () => speech.stepSentence(-1))}
      {pauseOrGoOn}
      {step('Next sentence', ChevronRight, () => speech.stepSentence(1))}
      {step('Next paragraph', SkipForward, () => speech.stepParagraph(1))}
      {speech.chapters.forward ? step('Next chapter', ChevronsRight, () => speech.stepChapter(1)) : null}
      {/* ⚠️ **PRESENT ONLY WHERE THERE IS SOMETHING TO SCRUB.** `speech.at` is
          null on the platform speaker, which cannot report a position or seek at
          all, so the control is ABSENT there rather than disabled: a disabled
          scrubber says "not now", and the true statement is "not on this voice".
          The same reasoning as the chapter buttons above. */}
      {speech.at === null ? null : (
        <input
          type="range"
          className={ui.scrub}
          min={0}
          max={SCRUB_STEPS}
          /* ROUNDED TO A STEP, so the thumb does not jitter between two pixels
             four times a second while the value it stands for has not visibly
             moved. The fraction that goes back out is computed from the step. */
          value={Math.round(fractionOf(speech.at) * SCRUB_STEPS)}
          title={`${clockOf(speech.at.positionMs)} of ${clockOf(speech.at.durationMs)}`}
          aria-label="How far through the chapter"
          aria-valuetext={`${clockOf(speech.at.positionMs)} of ${clockOf(speech.at.durationMs)}`}
          onChange={(event) => speech.seekToFraction(Number(event.target.value) / SCRUB_STEPS)}
        />
      )}
      <button
        type="button"
        className={`${ui.barButton} ${ui.transportButton} ${ui.rate}`}
        /* ⚠️ **THE STEPS ARE `READING_RATE`'s, NOT A SECOND LIST.** Settings
           offers the same ramp from the same constant, so the speed a reader
           sets in one place is a speed the other can show. A literal here would
           be a second answer to which speeds exist, and the two would drift the
           first time the ramp changed. */
        title={`Reading speed — ${formatRate(rate)}, tap for the next`}
        aria-label={`Reading speed ${formatRate(rate)}`}
        onClick={() => onRate(nextRate(rate))}
      >
        {formatRate(rate)}
      </button>
      {step('Stop reading aloud', Square, () => speech.stop())}
    </div>
  )
}

/**
 * How many positions the scrubber has.
 *
 * A thousand, so one step of a 48-minute section is under three seconds — finer
 * than a reader can aim — while the value stays an integer the element can hold
 * without a floating-point round trip.
 */
const SCRUB_STEPS = 1000

/**
 * How far through, as a fraction — 0 where the section has no length yet.
 *
 * ⚠️ **A ZERO DURATION IS NOT A DIVISION.** A section of one sample rounds to
 * 0 ms, and `0 / 0` is `NaN`, which a `<input type="range">` takes as its
 * minimum silently — so the thumb would sit at the start of a chapter that had
 * finished, with nothing saying why.
 */
export function fractionOf(at: { readonly positionMs: number; readonly durationMs: number }): number {
  if (at.durationMs <= 0) return 0
  return Math.min(1, Math.max(0, at.positionMs / at.durationMs))
}

/**
 * Milliseconds as a clock a reader reads — `4:07`, or `1:02:30` past an hour.
 *
 * ⚠️ **HOURS ARE NOT OPTIONAL HERE.** WI-34.0 measured the character-weighted
 * median section of this shelf at 48.6 minutes and its p95 at over an hour, so a
 * `m:ss` format would show `68:12` for a real chapter — which reads as
 * sixty-eight minutes only if you already knew it could not be sixty-eight
 * seconds.
 */
export function clockOf(ms: number): string {
  /* ⚠️ **`Math.max` RATHER THAN `ms > 0` — FOUND BY THE MUTATION SWEEP.** The
     clause is there to refuse a NEGATIVE, and at zero `> 0` and `>= 0` give the
     same answer — so the comparison had a mutant nothing could kill. Clamping says
     the same thing with no boundary to be wrong about. */
  const whole = Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / 1000) : 0
  const seconds = whole % 60
  const minutes = Math.floor(whole / 60) % 60
  const hours = Math.floor(whole / 3600)
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * The next speed up the ramp, wrapping to the slowest at the top.
 *
 * WRAPS rather than stopping, because this is one button doing a stepper's job:
 * stopping at 2.5× would leave a reader who overshot with no way back except the
 * settings pane. The ramp is short enough that going round is quicker.
 *
 * ⚠️ **THE FIRST STEP ABOVE THE CURRENT RATE, NOT ONE PAST THE NEAREST.** This
 * found the nearest step and advanced from it, which is right on the ramp and
 * wrong off it — and off it is exactly the case the nearest-match existed for: a
 * rate stored by a build with a different ramp. Measured: `1.4` advanced to
 * `1.75`, skipping `1.5`, because its nearest step is `1.5` and the one after
 * that is `1.75`; and `2.4` WRAPPED to `0.5`, skipping `2.5` entirely, because
 * its nearest step is the top one. "Faster" should never skip a speed the ramp
 * offers, and it should never go slower while a faster one exists.
 *
 * So: the smallest step strictly greater than the rate, and the slowest only
 * when nothing is. On the ramp the two rules give the same answer; off it, only
 * this one is right. The slowest is `READING_RATE_MIN`, read off the ramp once
 * where it is defined, rather than `steps[0]` with a fallback for a ramp of no
 * steps that the settings' own cases refuse.
 */
export function nextRate(rate: number): number {
  return READING_RATE.steps.find((step) => step > rate) ?? READING_RATE_MIN
}

/** `1×`, `1.25×` — no trailing zero, because `1.00×` reads as a measurement. */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`
}
