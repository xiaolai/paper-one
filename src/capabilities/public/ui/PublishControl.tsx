import { useEffect, useState } from 'react'
import { CAPABILITY_UI, messageOf } from '../../../kernel'
import type { PublicPassage } from '../../../kernel'
import type { PublishPublicPort } from '../lib/publishPort'

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
  /** Told what was published, so a caller can offer to take it back. */
  readonly onPublished?: (published: { readonly pub: string; readonly voice: string }) => void
}

export function PublishControl({ bookId, passage, sharedWithCircle, port, onPublished }: PublishControlProps) {
  const [asked, setAsked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  /* `undefined` until asked, so the disclosure is never drawn from a list that
     has not been loaded — an empty array and "not looked yet" are the two
     states this control must not confuse. */
  const [shared, setShared] = useState<readonly PublicPassage[] | undefined>(undefined)

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
        <button type="button" className={CAPABILITY_UI.button} onClick={() => setAsked(true)}>
          Publish…
        </button>
      </div>
    )
  }

  const publish = (): void => {
    setBusy(true)
    setTrouble(null)
    port
      .publish({ bookId, passage, acknowledged: true })
      .then((published) => {
        setDone(true)
        onPublished?.(published)
      })
      .catch((cause: unknown) => setTrouble(messageOf(cause)))
      .finally(() => setBusy(false))
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
        <button type="button" className={CAPABILITY_UI.button} disabled={busy} onClick={() => setAsked(false)}>
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
