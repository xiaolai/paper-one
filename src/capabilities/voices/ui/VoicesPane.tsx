import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI as ui, messageOf, packArrived, packSize, type InstallProgress, type VoicePack } from '../../../kernel'
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

/* ⚠️ **THE KERNEL'S, NOT A SECOND PAIR.** These lived here and `engineVoice.ts`
   had its own copy for the Listen control's notice; the two rounded in
   different orders and disagreed at 1 023.6 MiB — `1.0 GB` against `1024 MB` —
   which nobody would have found by reading either. Re-exported so this file's
   own cases can drive them directly. */
export { packArrived as arrivedOf, packSize as sizeOf }

/** What a download has got to, as a sentence. */
export function progressLine(progress: InstallProgress): string {
  if (progress.kind === 'verifying') return 'Checking every byte'
  if (progress.kind === 'installed') return 'Installed'
  const total = progress.total > 0 ? ` of ${packSize(progress.total)}` : ''
  return `Downloading · ${packArrived(progress.received)}${total}`
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
  /* ⚠️ **TWO READS CAN BE IN FLIGHT, AND THE OLDER ONE USED TO WIN.** The timer
   * polls while `install` and `remove` each ask for a fresh read of their own,
   * so the answers arrive in whatever order the plugin finishes them — and a
   * stale one landing last put `installed: false` back on a pack that had just
   * finished installing. `alive` cannot see this: both reads belong to a live
   * pane. Only the newest answer is applied. */
  const asked = useRef(0)
  /* One per download in flight, so Stop can reach the fetch. The port takes an
   * `AbortSignal` and the plugin holds the token the fetch loop waits on —
   * which is what leaves nothing half-installed. */
  const stopping = useRef(new Map<string, AbortController>())

  const refresh = useCallback(async () => {
    const mine = ++asked.current
    try {
      const rows = await port.catalogue()
      if (!alive.current || mine !== asked.current) return
      setPacks(rows)
      setFailed(null)
    } catch (cause) {
      if (!alive.current || mine !== asked.current) return
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

  /* ⚠️ **A FAILED POLL USED TO REPLACE THE WHOLE PANE, STOP BUTTONS AND ALL.**
   * The catalogue is re-read every few seconds; one refusal in the middle of a
   * 2.3 GB download took away the rows, the progress line and the only control
   * that could stop it, and put them back on the next poll. The sentence is
   * only the whole pane when there is nothing else to show — which is the case
   * it was written for, a plugin that never answered at all. */
  if (failed !== null && packs === null) {
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
      {/* Beside the rows, not instead of them — see the guard above. */}
      {failed !== null ? <p className={ui.hint}>The voices could not be listed: {failed}</p> : null}
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
              {pack.summary} · {languagesOf(pack)} · {packSize(pack.bytes)} · needs {pack.minimumMemoryGb} GB of memory
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
