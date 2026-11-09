import { AudioLines } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui, ICON, type SettingsStore } from '../../../kernel'
import { RATE_SETTING, setRate } from '../lib/settings'
import { useReading, whole, type ReadingStore } from './reading'
import { ReadingTransport } from './ReadingTransport'

export interface ListenControlProps {
  readonly store: ReadingStore
  readonly settings: SettingsStore
}

/**
 * Listen, in the title bar beside the reading controls — and, while a reading
 * is under way, the transport in its place.
 *
 * Live where the engine can do it. §07 keeps the disabled state for the case
 * that remains real — a WebView built without Web Speech — rather than for a
 * feature that is simply unwritten.
 *
 * NOTHING UNTIL THE HOST HAS PUBLISHED, which in the running app is never a
 * frame: the host is a window host, drawn before the title bar, and `useReading`
 * reads it again before the first paint. A control that drew a guess before
 * that would be a control that could be pressed with nothing behind it.
 */
export function ListenControl({ store, settings }: ListenControlProps) {
  const reading = useReading(store, whole)
  const rate = useSyncExternalStore(settings.subscribe, () => settings.get(RATE_SETTING))
  if (reading === null) return null
  const { speech, listenRefusal, hasBook } = reading
  if (speech.speaking) {
    return <ReadingTransport speech={speech} rate={rate} onRate={(next) => setRate(settings, next)} />
  }
  const disabled = !speech.available || !hasBook || listenRefusal !== null
  return (
    <button
      type="button"
      className={ui.barButton}
      /* ⚠️ **A REFUSAL THE READING ITSELF REPORTED IS SHOWN HERE, AND IT USED TO
         BE SHOWN NOWHERE.** A chapter that could not be made into audio left this
         control back where it was with nothing said — indistinguishable from a
         chapter that had finished. `listenRefusal` outranks it: that one says
         the reading cannot START, which is the more actionable news, and it is
         why the control is disabled. */
      title={
        !speech.available
          ? 'Listen — this build has no speech engine'
          : listenRefusal !== null
            ? `Listen — ${listenRefusal}`
            : speech.refusal !== null
              ? `Listen — ${speech.refusal}`
              : 'Read this chapter aloud'
      }
      aria-label="Read aloud"
      aria-pressed={false}
      /* ⚠️ **THE SENTENCE ITSELF, WHERE IT USED TO BE AN EMPTY STRING — FOUND BY
         THE MUTATION SWEEP.** A presence attribute's value is whatever you like,
         so `''` had a mutant no test could tell from it. Carrying the refusal
         makes the attribute say WHY as well as THAT, which is worth having on a
         control a reader is looking at, and gives it one value a test can be
         wrong about. Nothing styles on it today; `[data-refused]` matches
         either way. */
      data-refused={speech.refusal ?? undefined}
      disabled={disabled}
      data-disabled={disabled}
      onClick={() => speech.start()}
    >
      <AudioLines size={ICON.control} strokeWidth={ICON.stroke} />
    </button>
  )
}
