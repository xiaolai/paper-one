import { useEffect, useRef, useState } from 'react'
import { CAPABILITY_UI, messageOf } from '../../../kernel'
import type { PublicPassage } from '../../../kernel'
import type { Published, PublishPublicPort } from '../lib/publishPort'

/**
 * Saying one passage publicly — WI-26.4's surface.
 *
 * ⚠️ **THE DISCLOSURE IS A STEP, NOT A CAPTION.** The reader is shown what
 * publishing means and has to answer for it before anything is minted; the
 * control has two states and the first one publishes nothing. A sentence
 * beside a button that publishes on the first click is a sentence nobody
 * reads.
 *
 * ⚠️ **AND IT IS PER ACT.** `mayPublish` refuses an unacknowledged public act
 * every time, so this component's acknowledgement resets after each
 * publication. A flag that survived the first one would make every later one
 * silent, which is the forwarding switch WI-26.4 forbids wearing a checkbox.
 *
 * ⚠️ **THE PORT REFUSES TOO.** This is a surface, and `publishPort.publish`
 * checks the same rule at the boundary — the two disagree exactly when a
 * caller forgets, which is what a boundary is for.
 */

export interface PublishControlProps {
  readonly bookId: string
  readonly passage: PublicPassage
  /**
   * The passages this reader has already sent their circle for this book.
   *
   * Empty is the ordinary case and the honest default for a build with no
   * circle composed. When these words are in it, the disclosure says so:
   * quote, prefix and suffix are identical by construction, so anybody in both
   * audiences can match them.
   *
   * ⚠️ **A FUNCTION, BECAUSE A CONSTANT DEFAULT IS HOW THIS WARNING DIED.**
   * This was `readonly sharedWithCircle?: readonly PublicPassage[]`, and the
   * only caller in the running app omitted it — so it defaulted to `[]`,
   * `linksVoiceToPerson` always answered `false`, and the strongest privacy
   * disclosure in the app could not appear. Found by audit. The answer lives on
   * disk in another capability, so an optional array was always going to be
   * defaulted by somebody; asking for it makes the omission a wiring question
   * rather than a silent `[]`.
   */
  readonly sharedWithCircle?: () => Promise<readonly PublicPassage[]>
  /** `null` before the capability has started. */
  readonly port: PublishPublicPort | null
  /**
   * Told what was published, so a caller can offer to take it back.
   *
   * ⚠️ **`Published`, AND IT USED TO BE A HAND-COPIED SUBSET OF IT.** The
   * spelled-out shape omitted `seq` — the field `port.withdraw` requires — so
   * a caller could not hand what it was given straight back to the port, which
   * is the one thing this callback exists for. Two spellings of one type, and
   * the shorter one made the taking-back path not typecheck.
   */
  readonly onPublished?: (published: Published) => void
}

export function PublishControl({ bookId, passage, sharedWithCircle, port, onPublished }: PublishControlProps) {
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  /**
   * WHICH passage the state above belongs to.
   *
   * ⚠️ **THE STATE SURVIVED THE PASSAGE CHANGING, AND `done` IS THE DANGEROUS
   * ONE.** A publication started for passage A and settling after the reader
   * moved to B set `done` — so B's control said *"Published. It cannot be
   * recalled"* about something nobody had published. `asked` and `trouble`
   * carried across the same way, showing one passage's disclosure step and one
   * passage's error over another. Reproduced by audit.
   *
   * Compared during render rather than reset in an effect: an effect resets
   * one paint LATER, and that paint is the one that lies.
   */
  const [belongsTo, setBelongsTo] = useState<string | null>(null)
  /* `undefined` until asked, so the disclosure is never drawn from a list that
     has not been loaded — an empty array and "not looked yet" are the two
     states this control must not confuse. */
  const [shared, setShared] = useState<readonly PublicPassage[] | undefined>(undefined)
  const identity = `${bookId}\u0000${passage.quote}\u0000${passage.prefix}\u0000${passage.suffix}`
  /* Read by an in-flight publication to find out whether it is still about the
     passage on screen. A closed-over `identity` cannot answer that: it is the
     value from the render that started the request, and comparing it with
     itself is always equal. */
  const showing = useRef(identity)
  showing.current = identity
  if (belongsTo !== identity) {
    setBelongsTo(identity)
    setAsked(false)
    setBusy(false)
    setTrouble(null)
    setDone(false)
    setShared(undefined)
  }

  /* ⚠️ **LOADED WHEN THE READER OPENS THE STEP, NOT ON EVERY RENDER.** The
     answer is a file in the circle's own storage; asking per paint would read
     it once per keystroke elsewhere in the pane. The disclosure is a deliberate
     second step, which is exactly the moment to find out what it should say. */
  useEffect(() => {
    if (!asked) return
    if (sharedWithCircle === undefined) {
      setShared([])
      return
    }
    let live = true
    sharedWithCircle()
      .then((passages) => {
        if (live) setShared(passages)
      })
      .catch(() => {
        /* The circle could not answer. Empty understates the warning, which is
           the wrong direction — so the port itself logs, and the reader still
           sees the base public disclosure rather than nothing at all. */
        if (live) setShared([])
      })
    return () => {
      live = false
    }
  }, [asked, sharedWithCircle])

  if (port === null) return null

  if (done) {
    return (
      <div className={CAPABILITY_UI.section}>
        <p className={CAPABILITY_UI.hint}>Published. It cannot be recalled from anyone who has already read it.</p>
      </div>
    )
  }

  if (!asked) {
    return (
      <div className={CAPABILITY_UI.row}>
        <span className={CAPABILITY_UI.grow}>Say this publicly</span>
        <button
          type="button"
          className={CAPABILITY_UI.button}
          onClick={() => {
            setAsked(true)
            setTrouble(null)
          }}
        >
          Publish…
        </button>
      </div>
    )
  }

  const publish = (): void => {
    setBusy(true)
    setTrouble(null)
    const mine = identity
    port
      .publish({ bookId, passage, acknowledged: true })
      .then(
        (published) => {
          /* ⚠️ **AN ANSWER FOR A PASSAGE THE READER HAS LEFT IS DISCARDED.**
             It settled, and it is about something else now — committing it
             would mark the passage on screen as published. The publication
             itself stands; what is dropped is the claim about THIS control. */
          if (showing.current !== mine) return
          setDone(true)
          /* ⚠️ **THE CALLBACK'S FAILURE IS NOT THE PUBLICATION'S.** This ran
             inside the `then`, so a throwing `onPublished` landed in the catch
             below — after `done` was already true, which hid the message
             behind the success branch and reported a failure that had not
             happened. The publication has landed; a listener that cannot cope
             with that is its own problem and says so in the log. */
          try {
            onPublished?.(published)
          } catch (cause) {
            console.error('Paper: a publication listener threw', cause)
          }
        },
        (cause: unknown) => {
          if (showing.current !== mine) return
          setTrouble(messageOf(cause))
        },
      )
      .finally(() => {
        if (showing.current === mine) setBusy(false)
      })
  }

  return (
    <div className={CAPABILITY_UI.section}>
      {/* ⚠️ **THE SENTENCE IS THE PORT'S, NOT THIS COMPONENT'S.**
          `disclosureFor` is the one place that decides what a reader is told,
          and a second wording here would be a second rule. */}
      {/* Nothing is drawn until the circle has answered: a disclosure shown
          from an unloaded list is the missing warning with extra steps. */}
      {shared === undefined ? (
        <p className={CAPABILITY_UI.hint}>Checking what you have already shared…</p>
      ) : (
        <p className={CAPABILITY_UI.hint}>{port.disclosure('public', passage, shared)}</p>
      )}
      <div className={CAPABILITY_UI.actions}>
        <button
          type="button"
          className={CAPABILITY_UI.button}
          disabled={busy}
          /* ⚠️ **THE ERROR GOES WITH THE STEP.** Cancel cleared only `asked`,
             so reopening the disclosure showed the previous attempt's failure
             above a button nobody had pressed yet. */
          onClick={() => {
            setAsked(false)
            setTrouble(null)
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${CAPABILITY_UI.button} ${CAPABILITY_UI.buttonPrimary}`}
          /* ⚠️ **NOT PUBLISHABLE BEFORE THE DISCLOSURE IS KNOWN.** Otherwise a
             fast click publishes under the base warning while the linking one
             was still loading — which is the whole defect, restored as a race. */
          disabled={busy || shared === undefined}
          onClick={publish}
        >
          Publish to anyone
        </button>
      </div>
      {trouble === null ? null : <p className={CAPABILITY_UI.hint}>{trouble}</p>}
    </div>
  )
}
