import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI as ui, messageOf, type InstallProgress, type VoicePack } from '../../../kernel'
import type { SpeechEnginePort } from '../../../kernel'

/**
 * Settings → **Voices**: the packs a reader can download, and the ones they have.
 *
 * ⚠️ **THIS PANE IS WHERE THE SIZE IS TOLD BEFORE IT IS SPENT.** A pack is
 * between 300 MB and 2.4 GB, which is not a thing to begin on a tap and explain
 * afterwards — so every row states its size, its languages and the memory it
 * needs before there is anything to press.
 *
 * ⚠️ **AND THE LICENCES ARE HERE, NOT ONLY IN `THIRD-PARTY-NOTICES.md`.** That
 * file covers what the app LINKS; these are weights fetched later, from hosts
 * the app names, and a reader downloading half a gigabyte of somebody else's
 * model should be told whose it is on the screen where they choose.
 */

/** How often the catalogue is re-read while the pane is open. */
const POLL_MS = 5000

/** Bytes in the unit a person reads them in. */
function inUnits(bytes: number): string {
  const mb = bytes / 1_048_576
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** A pack's SIZE, where a missing one is refused rather than drawn. */
export function sizeOf(bytes: number): string {
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
export function arrivedOf(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  return inUnits(bytes)
}

/** What a download has got to, as a sentence. */
export function progressLine(progress: InstallProgress): string {
  if (progress.kind === 'verifying') return 'Checking every byte'
  if (progress.kind === 'installed') return 'Installed'
  const total = progress.total > 0 ? ` of ${sizeOf(progress.total)}` : ''
  return `Downloading · ${arrivedOf(progress.received)}${total}`
}

/** The languages a pack reads, spelled for a person. */
export function languagesOf(pack: VoicePack, names = new Intl.DisplayNames(['en'], { type: 'language' })): string {
  const spelled = pack.languages.map((tag) => {
    /* `of` throws on a tag it cannot parse, and a catalogue is data — a row
     * with a malformed tag must not take the whole pane down. */
    try {
      return names.of(tag) ?? tag
    } catch {
      return tag
    }
  })
  return spelled.join(', ')
}

interface PackState {
  readonly progress: InstallProgress | null
  readonly error: string | null
}

/** What a reader is told when they stop a download themselves. */
export const STOPPED = 'Download stopped. Nothing was left half-installed.'

export function VoicesPane({ port }: { readonly port: SpeechEnginePort }) {
  const [packs, setPacks] = useState<readonly VoicePack[] | null>(null)
  const [states, setStates] = useState<Readonly<Record<string, PackState>>>({})
  const [failed, setFailed] = useState<string | null>(null)
  /* So a poll that lands after the pane closes does not set state on an
   * unmounted tree — the same reason every other polling pane holds one. */
  const alive = useRef(true)
  /* One per download in flight, so Stop can reach the fetch. The port takes an
   * `AbortSignal` and the plugin holds the token the fetch loop waits on —
   * which is what leaves nothing half-installed. */
  const stopping = useRef(new Map<string, AbortController>())

  const refresh = useCallback(async () => {
    try {
      const rows = await port.catalogue()
      if (!alive.current) return
      setPacks(rows)
      setFailed(null)
    } catch (cause) {
      if (!alive.current) return
      /* The catalogue is embedded in the binary, so a failure here is the
       * plugin not answering rather than a network problem — said plainly
       * instead of leaving an empty pane that reads as "no voices exist". */
      setFailed(messageOf(cause))
    }
  }, [port])

  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh])

  const install = useCallback(
    async (pack: VoicePack) => {
      const controller = new AbortController()
      stopping.current.set(pack.id, controller)
      setStates((was) => ({ ...was, [pack.id]: { progress: { kind: 'downloading', received: 0, total: pack.bytes }, error: null } }))
      try {
        await port.install(
          pack.id,
          (progress) => {
            if (!alive.current) return
            setStates((was) => ({ ...was, [pack.id]: { progress, error: null } }))
          },
          controller.signal,
        )
        if (!alive.current) return
        setStates((was) => ({ ...was, [pack.id]: { progress: null, error: null } }))
      } catch (cause) {
        if (!alive.current) return
        /* ⚠️ NAMED, NEVER SWALLOWED. A refused digest, a stopped download and a
         * full disk all end here, and a row that simply goes back to "Download"
         * tells a reader their tap did nothing. A stop is the reader's own
         * doing, so it says so rather than reading as a failure. */
        const why = controller.signal.aborted ? STOPPED : messageOf(cause)
        setStates((was) => ({ ...was, [pack.id]: { progress: null, error: why } }))
      }
      stopping.current.delete(pack.id)
      void refresh()
    },
    [port, refresh],
  )

  const remove = useCallback(
    async (pack: VoicePack) => {
      try {
        await port.remove(pack.id)
      } catch (cause) {
        if (alive.current) {
          setStates((was) => ({ ...was, [pack.id]: { progress: null, error: messageOf(cause) } }))
        }
      }
      void refresh()
    },
    [port, refresh],
  )

  if (failed !== null) {
    return (
      <div className={ui.section}>
        <p className={ui.hint}>The voices could not be listed: {failed}</p>
      </div>
    )
  }

  if (packs === null) {
    return (
      <div className={ui.section}>
        <p className={ui.hint}>Looking for voices…</p>
      </div>
    )
  }

  if (packs.length === 0) {
    return (
      <div className={ui.section}>
        <p className={ui.hint}>No voices are offered on this device.</p>
      </div>
    )
  }

  return (
    <div className={ui.section}>
      <p className={ui.hint}>
        A voice is downloaded once and read on this device. Nothing you listen to leaves it.
      </p>
      {packs.map((pack) => {
        const state = states[pack.id]
        const busy = state?.progress != null
        return (
          /* ⚠️ **THE FACTS GO UNDER THE ROW, NOT INSIDE IT** — measured in the
           * running app on 2026-09-23. They were in a `paper-cap-grow`, whose
           * own comment says it "takes the slack and truncates" so a long name
           * pushes the value off the row: 585 px of text was clipped into
           * 271 px, and everything from the size onwards was INVISIBLE. That
           * is the one thing this pane exists to say before a reader taps
           * Download. `paper-cap-hint` is the class for a sentence under a
           * row — it is a block, it wraps, and it carries the margin. */
          <div key={pack.id}>
            <div className={ui.row}>
              <div className={ui.grow}>
                <div className={ui.value}>{pack.name}</div>
              </div>
              <div className={ui.actions}>
                {pack.installed ? (
                  <button type="button" className={`${ui.button} ${ui.buttonDanger}`} onClick={() => void remove(pack)}>
                    Remove
                  </button>
                ) : busy ? (
                  <button
                    type="button"
                    className={ui.button}
                    onClick={() => stopping.current.get(pack.id)?.abort()}
                  >
                    Stop
                  </button>
                ) : (
                  <button type="button" className={`${ui.button} ${ui.buttonPrimary}`} onClick={() => void install(pack)}>
                    Download
                  </button>
                )}
              </div>
            </div>
            <div className={ui.hint}>
              {pack.summary} · {languagesOf(pack)} · {sizeOf(pack.bytes)} · needs {pack.minimumMemoryGb} GB of memory
            </div>
            <div className={ui.hint}>{pack.voices.map((voice) => voice.name).join(', ')}</div>
            {busy && state?.progress ? <div className={ui.hint}>{progressLine(state.progress)}</div> : null}
            {state?.error != null ? <div className={ui.hint}>{state.error}</div> : null}
          </div>
        )
      })}
      <p className={ui.hint}>
        Kokoro and Qwen3-TTS are Apache-2.0. The English pronunciations come from misaki (Apache-2.0)
        and CMUdict (BSD-2-Clause).
      </p>
    </div>
  )
}
