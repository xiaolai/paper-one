import { useCallback, useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI, isWellFormed, messageOf, standingOf, type VoiceDecisions } from '../../../kernel'
import type { VoiceDecisionsPort } from '../lib/voicePort'

/**
 * What this reader has decided about other people's voices — WI-26.5's surface.
 *
 * ⚠️ **THE READER'S OWN DECISIONS ONLY, AND THERE IS NO "BIND" BUTTON.**
 * `isWellFormed` refuses a binding whose `assertedBy` is not the subject, and
 * that check is the whole point of the record: a binding says *"this pseudonym
 * is my friend"*, and only that friend can say it. A control here that let the
 * reader type a person beside a voice would be inventing the one assertion the
 * type exists to require — so what this draws is silencing, un-silencing and
 * forgetting, every one of which is the reader's own to make. The assertion
 * arrives over the circle, and phase 26 does not carry it yet.
 *
 * ⚠️ **A SILENCED VOICE IS STILL LISTED, AND IT HAS TO BE.** Blocking is
 * enforced before storage — `takePublic` refuses the envelope — so a voice the
 * reader silenced leaves no trace in the book's file and would vanish from a
 * list built only from what was heard. The reader could then never take it
 * back. The two sources are unioned: what this book carried, and what this
 * device has silenced anywhere.
 *
 * ⚠️ **THE DECISION IS DEVICE-WIDE AND THE PANE IS PER BOOK**, so the copy says
 * so. A reader silencing a voice from inside one book is silencing it in every
 * book, and a surface that let them think otherwise would be lying quietly.
 */

export interface VoiceDecisionsProps {
  /** The voices this book's file actually carried. May be empty. */
  readonly heard: readonly string[]
  /** `null` before the capability has started, and on a build with no filesystem. */
  readonly port: VoiceDecisionsPort | null
}

/** As much of an id as identifies it on screen without pretending to be a name. */
function shortly(id: string): string {
  return id.slice(0, 12)
}

/**
 * One silence, with the two states it has.
 *
 * ⚠️ **FOUR NEAR-IDENTICAL BUTTON BRANCHES STOOD HERE**, differing in a label,
 * an operation and — the part that matters — WHICH CLASS THEY CARRIED. The
 * silencing half is `buttonDanger` and the un-silencing half is not, which is
 * a rule about what a destructive control looks like; written out four times
 * it is a rule three of them could stop following without anything noticing.
 * `capabilityStyle.contract.test.ts` already walks this file for a modifier
 * travelling without its base class, and this is the same rule from the other
 * end. Found by audit.
 *
 * ⚠️ **`silenced` DECIDES THE TREATMENT, NOT THE CALLER.** Taking a colour as a
 * prop would put the decision back at each call site, which is exactly what
 * was wrong with the four copies.
 */
/**
 * The subscription, the reads and the actions — everything this control DOES,
 * apart from drawing.
 *
 * ⚠️ **EXTRACTED FROM A COMPONENT THAT DID ALL OF IT INLINE.** Lifecycle,
 * ordering, error state and four kinds of row were one function, so a
 * state-transition defect — and there have been three here — could only be
 * looked for by reading the whole thing. What is left in the component is
 * which rows exist and what they say. Found by audit.
 */
function useVoiceDecisions(port: VoiceDecisionsPort | null): {
  readonly decisions: VoiceDecisions | null
  readonly trouble: string | null
  readonly busy: boolean
  readonly act: (run: () => Promise<unknown>) => void
} {
  const [decisions, setDecisions] = useState<VoiceDecisions | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /* ⚠️ **READS COMMIT IN COMPLETION ORDER UNLESS SOMETHING STOPS THEM.** Every
     change fires `subscribe`, so several reads are in flight routinely — and an
     older one landing last put a silenced voice back on screen as un-silenced.
     Reproduced by audit. A counter rather than a per-call `live` flag because
     the reads are started from two places and must be ordered against EACH
     OTHER, not merely cancelled with the effect. */
  const latest = useRef(0)

  const refresh = useCallback(() => {
    if (port === null) return
    const mine = (latest.current += 1)
    port
      .decisions()
      .then((held) => {
        if (latest.current !== mine) return
        setDecisions(held)
        /* A read that succeeded clears the previous failure: leaving it would
           report trouble the device has recovered from. */
        setTrouble(null)
      })
      .catch((cause: unknown) => {
        if (latest.current !== mine) return
        setTrouble(messageOf(cause))
      })
  }, [port])

  useEffect(() => {
    /* ⚠️ **THE PREVIOUS PORT'S ANSWERS ARE NOT THIS PORT'S.** Without this the
       control kept drawing the old device's decisions until the new read
       landed — and for ever if it failed. Nulling is the same "not looked yet"
       state the first render has. */
    setDecisions(null)
    setTrouble(null)
    latest.current += 1
    refresh()
    return port?.subscribe(refresh)
  }, [port, refresh])

  /* One action, one shape: run it, report what went wrong, and let the port's
     own subscription bring the new state back rather than setting it here. Two
     paths to the same state is how a surface starts disagreeing with its
     store. */
  const act = useCallback((run: () => Promise<unknown>): void => {
    setBusy(true)
    setTrouble(null)
    run()
      .catch((cause: unknown) => setTrouble(messageOf(cause)))
      .finally(() => setBusy(false))
  }, [])

  return { decisions, trouble, busy, act }
}

function SilenceToggle({
  silenced,
  busy,
  silence,
  hear,
  onSilence,
  onHear,
}: {
  readonly silenced: boolean
  readonly busy: boolean
  /** What the button says when it will silence. */
  readonly silence: string
  /** What it says when it will stop silencing. */
  readonly hear: string
  readonly onSilence: () => void
  readonly onHear: () => void
}) {
  return silenced ? (
    <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={onHear}>
      {hear}
    </button>
  ) : (
    <button
      type="button"
      /* ⚠️ **A MODIFIER NEVER TRAVELS WITHOUT THE CLASS IT MODIFIES** —
         `buttonDanger` alone is a colour with no button under it. */
      className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonDanger}`}
      disabled={busy}
      onClick={onSilence}
    >
      {silence}
    </button>
  )
}

export function VoiceDecisionsControl({ heard, port }: VoiceDecisionsProps) {
  const { decisions, trouble, busy, act } = useVoiceDecisions(port)

  if (port === null) return null
  /* ⚠️ **UNREADABLE IS SAID, NOT DRAWN AS EMPTY.** `voicePort.decisions`
     THROWS on a file it cannot parse rather than collapsing it to "no
     decisions" — the whole reason that distinction exists — and a surface that
     answered a throw with a blank section would put the collapse back at the
     last possible moment. A reader whose silences are not being applied has to
     be told; the alternative is hearing somebody they silenced and having no
     way to know why. */
  if (decisions === null) {
    return trouble === null ? null : (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Paper could not read what you have decided about other people’s voices, so none of it is being applied. {trouble}</p>
      </div>
    )
  }

  /* ⚠️ **INDEXED, NOT SEARCHED THREE DEEP.** This was
     `blockedPeople.filter(person => voices.some(voice => bindings.find(...)))`
     — up to people × voices × bindings comparisons on EVERY render, including
     the ones a button press causes, over three lists a stranger chooses the
     length of. `MAX_DECISIONS` is 4 096 each. One pass builds the index the
     other two need. */
  const personOfVoice = new Map<string, string>()
  for (const one of decisions.bindings) {
    if (isWellFormed(one) && !personOfVoice.has(one.voice)) personOfVoice.set(one.voice, one.person)
  }
  const silencedVoices = new Set(decisions.blockedVoices)
  const silencedPeople = new Set(decisions.blockedPeople)
  /* Heard on this book, plus silenced anywhere — see the note above. Sorted so
     the list does not reorder itself under the reader between renders. */
  const voices = [...new Set([...heard, ...decisions.blockedVoices])].sort()
  const peopleShown = new Set<string>()
  for (const voice of voices) {
    const person = personOfVoice.get(voice)
    if (person !== undefined) peopleShown.add(person)
  }
  /* A person the reader silenced with no voice of theirs in this list would
     otherwise have no row to be un-silenced from. */
  const orphanedPeople = decisions.blockedPeople.filter((person) => !peopleShown.has(person))

  if (voices.length === 0 && orphanedPeople.length === 0) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Nobody has published anything about this book that this device has read.</p>
        {/* ⚠️ **THE FAILURE IS SHOWN HERE TOO, AND IT WAS NOT.** A read that
            succeeded once and then failed leaves `decisions` set, so this
            branch drew "nobody has published anything" over an error the
            reader never saw — the reassuring answer being the wrong one. */}
        {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
      </div>
    )
  }

  return (
    <div className={CAPABILITY_UI.section}>
      <p className={CAPABILITY_UI.hint}>
        Silencing is for this device and every book on it, not only this one.
      </p>
      {voices.map((voice) => {
        const standing = standingOf(voice, decisions)
        const person = personOfVoice.get(voice)
        const silencedByVoice = silencedVoices.has(voice)
        const silencedByPerson = person !== undefined && silencedPeople.has(person)
        return (
          <div key={voice} className={CAPABILITY_UI.section}>
            <div className={CAPABILITY_UI.row}>
              <span className={`${CAPABILITY_UI.grow} ${CAPABILITY_UI.code}`}>{shortly(voice)}</span>
              <span className={CAPABILITY_UI.value}>
                {/* The standing is the kernel's word, not a second rule here. */}
                {standing === 'bound' && person !== undefined
                  ? `someone you know — ${shortly(person)}`
                  : standing === 'blocked'
                    ? 'silenced'
                    : 'a stranger'}
              </span>
            </div>
            <div className={CAPABILITY_UI.actions}>
              <SilenceToggle
                silenced={silencedByVoice}
                busy={busy}
                silence="Silence this voice"
                hear="Hear this voice again"
                onSilence={() => act(() => port.blockVoice(voice))}
                onHear={() => act(() => port.unblockVoice(voice))}
              />
              {person === undefined ? null : (
                <SilenceToggle
                  silenced={silencedByPerson}
                  busy={busy}
                  silence="Silence everything from them"
                  hear={`Hear ${shortly(person)} again`}
                  onSilence={() => act(() => port.blockPerson(person))}
                  onHear={() => act(() => port.unblockPerson(person))}
                />
              )}
              {person === undefined ? null : (
                <button
                  type="button"
                  className={CAPABILITY_UI.button}
                  disabled={busy}
                  onClick={() => act(() => port.unbind(voice))}
                >
                  Forget that this is theirs
                </button>
              )}
            </div>
          </div>
        )
      })}
      {orphanedPeople.map((person) => (
        <div key={person} className={CAPABILITY_UI.row}>
          <span className={`${CAPABILITY_UI.grow} ${CAPABILITY_UI.code}`}>{shortly(person)}</span>
          <button
            type="button"
            className={CAPABILITY_UI.button}
            disabled={busy}
            onClick={() => act(() => port.unblockPerson(person))}
          >
            Hear them again
          </button>
        </div>
      ))}
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
    </div>
  )
}
