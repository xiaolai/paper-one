import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI as ui, messageOf, packArrived, packSize, type InstallProgress, type VoicePack } from '../../../kernel'
import type { ClipUsage, SpeechEnginePort } from '../../../kernel'
import { STOPPED, theDownloads, type Downloads } from '../lib/downloads'

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
/** How often the catalogue is re-read while the pane is open. */
export const POLL_MS = 5000

/* ⚠️ **THE KERNEL'S, NOT A SECOND PAIR.** These lived here and `engineVoice.ts`
   had its own copy for the Listen control's notice; the two rounded in
   different orders and disagreed at 1 023.6 MiB — `1.0 GB` against `1024 MB` —
   which nobody would have found by reading either. Re-exported so this file's
   own cases can drive them directly. */
export { packArrived as arrivedOf, packSize as sizeOf }

/**
 * What the rendered reading holds, in a sentence.
 *
 * ⚠️ **EXPORTED AND ASKED DIRECTLY, BECAUSE THE DOM FLATTENS ITS ANSWERS.** The
 * pane's own record for `voicePickerValue` says why: a value drawn into markup
 * collapses several decisions into one string, and a case that drives the pane
 * cannot tell an empty store from one whose numbers rounded to the same words.
 *
 * ⚠️ **`packSize` REFUSES ZERO — CORRECTLY, AND NOT FOR THIS.** It answers
 * *"unknown size"* for a pack whose catalogue row has no size, which is right for
 * a SIZE and wrong for a COUNT: nought bytes of rendered reading is an ordinary
 * amount and not a missing one. Same rule the `sizeOf`/`arrivedOf` pair records.
 */
export function usageLine(usage: ClipUsage): string {
  const held = usage.clips === 0 ? 'nothing yet' : `${packSize(usage.bytes)} in ${usage.clips === 1 ? '1 chapter' : `${usage.clips} chapters`}`
  return `${held} · up to ${packSize(usage.budget)} is kept · the least recently played goes first`
}

/** What a download has got to, as a sentence. */
export function progressLine(progress: InstallProgress): string {
  if (progress.kind === 'verifying') return 'Checking every byte'
  if (progress.kind === 'installed') return 'Installed'
  const total = progress.total > 0 ? ` of ${packSize(progress.total)}` : ''
  return `Downloading · ${packArrived(progress.received)}${total}`
}

/** The languages a pack reads, spelled for a person. */
/* The app's own language, not the machine's: a list written in one locale and
   the rest of the pane in another is the `Intl` trap this repository already
   records for sentence segmentation, wearing a second hat. */
export function languagesOf(pack: VoicePack, names = new Intl.DisplayNames('en', { type: 'language' })): string {
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

/* The sentence belongs to the registry, which is the only thing that knows who
   asked for the stop. Re-exported because this is the file a reader of the pane
   looks in for it. */
export { STOPPED }

export function VoicesPane({
  port,
  downloads = theDownloads,
}: {
  readonly port: SpeechEnginePort
  /** The app's registry; a case passes its own so two cannot leak into each other. */
  readonly downloads?: Downloads
}) {
  const [packs, setPacks] = useState<readonly VoicePack[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** Which packs are being removed, and what a removal said if it refused. */
  const [removing, setRemoving] = useState<Readonly<Record<string, boolean>>>({})
  const [failedRemoval, setFailedRemoval] = useState<Readonly<Record<string, string | null>>>({})
  /* ⚠️ **TWO READS CAN BE IN FLIGHT, AND THE OLDER ONE USED TO WIN.** The timer
   * polls while `install` and `remove` each ask for a fresh read of their own,
   * so the answers arrive in whatever order the plugin finishes them — and a
   * stale one landing last put `installed: false` back on a pack that had just
   * finished installing. Only the newest answer is applied.
   *
   * ⚠️ **AN IDENTITY, NOT A COUNTER.** A number counted up, and counting down
   * would have discriminated exactly as well — an arithmetic nothing could
   * observe. A fresh object is the read, and cannot be any other read.
   *
   * ⚠️ **AND AN `alive` REF STOOD BESIDE IT AND DECIDED NOTHING.** It guarded
   * every `set…` against an unmounted tree, which React 18 makes a no-op — so
   * a pane that had closed applied its answer to nothing whether or not the
   * guard ran, and the guard was a branch no test could reach. What actually
   * protects the rows is this token: both reads belong to a live pane, which
   * is the case `alive` could never see. */
  const asked = useRef<object>({})
  /** Which packs are being removed RIGHT NOW — see `remove` for why not state. */
  const removingNow = useRef<Set<string>>(new Set())
  /* ⚠️ **THE DOWNLOADS ARE NOT THIS PANE'S**, and they were. Each lived in a
   * `useRef` map of `AbortController`s beside React state, so closing Settings
   * — or a hot reload, which is how this was first seen — threw away the
   * progress and the only control that could stop a 2.3 GB fetch, while the
   * plugin went on fetching. Reopening showed **Download** on a pack that was
   * half here. `theDownloads` outlives the tree; this only watches it. */
  /**
   * How much disk the rendered reading holds — WI-34.5's *eviction shown*.
   *
   * ⚠️ **SHOWN BECAUSE IT IS REAL DISK A READER CANNOT OTHERWISE FIND.** Five
   * gigabytes of audio derived from books they already have, and the only sign of
   * it without this row is that a chapter they heard last week is made again. The
   * same argument the export's `leftBehind` count makes: a tidy-up failure was
   * swallowed, and *"nothing was left behind"* was asserted with nothing checking.
   */
  const [usage, setUsage] = useState<ClipUsage | null>(null)
  /* ⚠️ **ITS OWN TOKEN, NOT THE CATALOGUE'S `asked`.** The two reads are started
     together and race each other; one shared token means whichever answers second
     cancels the first's result. An IDENTITY rather than a counter, for the reason
     `EngineSpeaker.#current` records — a fresh object cannot collide, ever. */
  const askedUsage = useRef<object>({})
  const [forgetting, setForgetting] = useState(false)
  /* ⚠️ **THE LOCK IS THE REF, NOT THE STATE** — the same defect `remove` records
     below: two presses before React commits the first both read the old value. */
  const forgettingNow = useRef(false)
  const [running, setRunning] = useState(downloads.states)
  useEffect(() => downloads.watch(() => setRunning(downloads.states())), [downloads])

  const refresh = useCallback(async () => {
    const mine = (asked.current = {})
    try {
      const rows = await port.catalogue()
      if (mine !== asked.current) return
      setPacks(rows)
      setFailed(null)
    } catch (cause) {
      if (mine !== asked.current) return
      /* The catalogue is embedded in the binary, so a failure here is the
       * plugin not answering rather than a network problem — said plainly
       * instead of leaving an empty pane that reads as "no voices exist". */
      setFailed(messageOf(cause))
    }
  }, [port])

  const readUsage = useCallback(async () => {
    const mine = (askedUsage.current = {})
    try {
      const read = await port.clipUsage()
      if (mine !== askedUsage.current) return
      setUsage(read)
    } catch {
      /* ⚠️ **SILENT, AND THAT IS THE ONE PLACE IN THIS PANE IT IS RIGHT.** A
       * build without the store answers nothing, and a row about disk is not
       * worth a sentence explaining its own absence beside a catalogue that
       * loaded. `failed` above is for the catalogue, which is the pane's subject. */
      if (mine === askedUsage.current) setUsage(null)
    }
  }, [port])

  useEffect(() => {
    void refresh()
    void readUsage()
    const timer = setInterval(() => {
      void refresh()
      void readUsage()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh, readUsage])

  const forget = useCallback(async () => {
    if (forgettingNow.current) return
    forgettingNow.current = true
    setForgetting(true)
    try {
      await port.forgetClips()
    } catch {
      /* Nothing is lost by a refused forget: the audio is derived, and the row
         below will show it is still there. */
    }
    forgettingNow.current = false
    setForgetting(false)
    void readUsage()
  }, [port, readUsage])

  const install = useCallback(
    async (pack: VoicePack) => {
      try {
        await downloads.begin(pack.id, pack.bytes, (report, signal) => port.install(pack.id, report, signal))
      } catch {
        /* The registry has already recorded why, and it is drawn from there —
           `messageOf`'s sentence and nothing else is lost. Caught so an
           ordinary refusal is not an unhandled rejection. */
      }
      void refresh()
    },
    [downloads, port, refresh],
  )

  const remove = useCallback(
    async (pack: VoicePack) => {
      /* ⚠️ **A SECOND PRESS USED TO START A SECOND REMOVAL**, and a retry that
       * worked left the previous sentence on the row. Marked pending, which
       * also disables the control, and cleared on the way in.
       *
       * ⚠️ **THE LOCK IS THE REF, NOT THE STATE.** `removing` is a RENDER
       * SNAPSHOT: two presses before React has committed the first both read
       * the old map and both started a removal — the same defect
       * `useAudiobook` records for `running`, which is why the disabled
       * attribute alone is not the answer either. The ref is written before
       * the first `await`, so the second press sees it. */
      if (removingNow.current.has(pack.id)) return
      removingNow.current.add(pack.id)
      setRemoving((was) => ({ ...was, [pack.id]: true }))
      downloads.clear(pack.id)
      setFailedRemoval((was) => ({ ...was, [pack.id]: null }))
      try {
        await port.remove(pack.id)
      } catch (cause) {
        setFailedRemoval((was) => ({ ...was, [pack.id]: messageOf(cause) }))
      }
      removingNow.current.delete(pack.id)
      setRemoving((was) => ({ ...was, [pack.id]: false }))
      void refresh()
    },
    [downloads, port, refresh],
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
        const state = running[pack.id]
        /* ONE reading of it. `busy && state?.progress` asked the same question
           twice — `busy` IS "there is progress" — so neither half could be the
           one that decided. */
        const progress = state?.progress ?? null
        const busy = progress !== null
        const error = state?.error ?? failedRemoval[pack.id] ?? null
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
                  <button
                    type="button"
                    className={`${ui.button} ${ui.buttonDanger}`}
                    disabled={removing[pack.id] === true}
                    onClick={() => void remove(pack)}
                  >
                    Remove
                  </button>
                ) : busy ? (
                  <button type="button" className={ui.button} onClick={() => downloads.stop(pack.id)}>
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
            {progress !== null ? <div className={ui.hint}>{progressLine(progress)}</div> : null}
            {error !== null ? <div className={ui.hint}>{error}</div> : null}
          </div>
        )
      })}
      {usage === null ? null : (
        <div>
          <div className={ui.row}>
            <div className={ui.grow}>
              <div className={ui.value}>Chapters made into audio</div>
            </div>
            <div className={ui.actions}>
              <button
                type="button"
                className={ui.button}
                disabled={forgetting || usage.clips === 0}
                onClick={() => void forget()}
              >
                Forget them
              </button>
            </div>
          </div>
          {/* ⚠️ **THE FACTS GO UNDER THE ROW** — the same measurement the pack
              rows record: a `paper-cap-grow` truncates, and 585 px of text was
              clipped into 271 px with everything from the size onwards invisible. */}
          <div className={ui.hint}>{usageLine(usage)}</div>
        </div>
      )}
      <p className={ui.hint}>
        Kokoro and Qwen3-TTS are Apache-2.0. The English pronunciations come from misaki (Apache-2.0)
        and CMUdict (BSD-2-Clause).
      </p>
    </div>
  )
}
