import { useEffect, useId, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import type { RouteRow, RoutesModel } from './routesModel'

/**
 * The **Companion** section (`companion:provider`, order 5), rendered by the
 * kernel's Settings pane.
 *
 * Decisions live in `routesModel.ts` (tested, no React); this adapter draws
 * the snapshot. Drawn with `CAPABILITY_UI` — nothing here invents a colour, a
 * radius, a height or a control.
 *
 * It is the second time `capability.css` has had to answer the "what control
 * is this?" question. Its own header records the first: the two shipped
 * capabilities drew with raw `<button>` and `<input>` and rendered in
 * system-blue browser chrome. A capability reaching for a kernel control is
 * the mechanism, not the mistake, and a plan that sketches one is how the
 * next instance arrives — so this pane uses the vocabulary and nothing else.
 */

export interface CompanionPaneProps {
  readonly model: RoutesModel
  /* ⚠️ `hasDictionary` USED TO BE HERE, and the episode is worth keeping even
   * though the prop is not. It was optional and defaulted to `false`; the
   * production caller passed nothing; so on macOS — the one platform that HAD
   * a dictionary — it was excluded from the Look up cycle and the reader could
   * not select `System dictionary` or `Both` at all. A default that is wrong
   * on the platform a feature exists for is not a default, and an optional
   * prop is how a caller forgets to answer.
   *
   * It was made required, and now it is deleted with the row it fed. The fact
   * it replaced lives on `GlossProvider.installAt`, stated by the object
   * that knows it rather than passed down from a root that has to remember. */
}

/**
 * One route's action, exhaustively.
 *
 * A `switch` rather than the four-level nested ternary this replaces: five
 * states rendered by nesting is unreadable, and — the part that matters — a
 * sixth `RowAction` would fall through the last `: null` and render NOTHING,
 * silently. Here it is a type error.
 *
 * ⚠️ **EVERY BUTTON NAMES ITS ROUTE.** They all read `Use` or `Sign in…`, and
 * the label beside them is a sibling `<span>`, not a `<label>` — so a screen
 * reader announced a list of identical buttons and there was no way to tell
 * which route any of them belonged to.
 */
function RouteAction({ row, model }: { readonly row: RouteRow; readonly model: RoutesModel }) {
  switch (row.action) {
    case 'in-use':
      return <span className={ui.value}>In use</span>
    case 'use':
      return (
        <button
          type="button"
          className={ui.button}
          aria-label={`Use ${row.label}`}
          onClick={() => model.use(row.id)}
        >
          Use
        </button>
      )
    case 'sign-in':
      return (
        <button
          type="button"
          className={ui.button}
          aria-label={`Sign in to ${row.label}`}
          onClick={() => void model.signIn(row.id)}
        >
          Sign in…
        </button>
      )
    case 'check-again':
      /* The vendor's login runs in a browser and tells Paper nothing when it
         finishes, so this is the reader's way to ask. Without it the row said
         `Signed out` for as long as they were logged in, and pressing it
         again opened a second flow. */
      return (
        <button
          type="button"
          className={ui.button}
          aria-label={`Check whether ${row.label} is signed in`}
          onClick={() => void model.refresh().catch(() => {})}
        >
          Check again
        </button>
      )
    case 'install':
      /* A local model that is not installed carries `Install` instead of
         `Use`, so one list does provisioning and selection without becoming
         two. The Local models section owns the download. */
      return <span className={ui.value}>Install in Local models</span>
    case 'none':
      return null
  }
  /* ⚠️ **"HERE IT IS A TYPE ERROR" WAS NOT TRUE UNTIL THIS LINE.** A `switch`
     with no declared return type that falls off its end returns `undefined`,
     which React draws as nothing and `tsc` accepts — this repository does not
     set `noImplicitReturns` — so a seventh `RowAction` compiled clean and hid
     its row's control, the silence the switch was written to end. Measured by
     widening the union in memory: no error without this, one with it
     (2026-09-13 audit). `BrowsersPane` spells the same guard. */
  const unreached: never = row.action
  return unreached
}

export function CompanionPane({ model }: CompanionPaneProps) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  /* A local, so the check below narrows it inside the row lookup's callback
     too: read off `snapshot` there it needed a `?.` for a null the branch had
     already ruled out — an optional chain nothing could reach. */
  const { signInFailure } = snapshot
  const effortHint = useId()
  useEffect(() => {
    /* ⚠️ NOT FIRE-AND-FORGET. `refresh` never rejects — it absorbs a failed
     * probe into an empty route list — but `void` on a promise that later
     * gains a rejection is an unhandled one nobody notices, and StrictMode
     * runs this effect twice. The model's own generation guard makes the
     * second call harmless: the newer probe wins and the older is dropped
     * rather than landing on top of it. */
    void model.refresh().catch(() => {})
  }, [model])

  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Answers with</span>
        <span className={ui.value}>{snapshot.loading ? 'Checking…' : ''}</span>
      </div>

      {snapshot.rows.map((row) => (
        <div key={row.id} className={ui.row}>
          <span className={ui.grow}>{row.label}</span>
          <span className={ui.value}>{row.value}</span>
          <RouteAction row={row} model={model} />
        </div>
      ))}

      {/* NOTHING TO LIST IS STILL AN ANSWER, and it drew as a bare heading. A
          probe that failed is absorbed into an empty list (`routesModel`'s
          `refresh`), so this is also what a dead plugin looks like, and asking
          again is the one thing a reader can do about either. Not while the
          first check is out: "nothing found" before anything was looked for is
          a claim nobody checked (2026-09-13 audit). */}
      {!snapshot.loading && snapshot.rows.length === 0 ? (
        <>
          <div className={ui.row}>
            <span className={ui.grow}>Nothing found to answer with</span>
            <button
              type="button"
              className={ui.button}
              aria-label="Check again for something to answer with"
              onClick={() => void model.refresh().catch(() => {})}
            >
              Check again
            </button>
          </div>
          <div className={ui.hint}>
            A model installed in Local models, an endpoint added in Cloud endpoints, or Codex or Claude once
            installed and signed in can answer here.
          </div>
        </>
      ) : null}

      {snapshot.fellBack && snapshot.inUse !== null ? (
        <div className={ui.hint}>
          The route you chose is not available, so the companion is answering with{' '}
          {snapshot.rows.find((row) => row.id === snapshot.inUse)?.label ?? snapshot.inUse}. Your
          choice is remembered and will come back when it does.
        </div>
      ) : null}

      {/* ⚠️ A LOGIN THAT WOULD NOT LAUNCH TOLD THE READER NOTHING. `signIn`
          catches, reports to the log, and puts the row back to `Sign in…` —
          which is right, and is also exactly what an ignored press looks like,
          so the reader's next move was to press it again. NAMED, because a
          list of several routes has no other way to say which one refused
          (2026-09-13 audit, round 2). */}
      {signInFailure !== null ? (
        <div className={ui.hint}>
          Signing in to{' '}
          {snapshot.rows.find((row) => row.id === signInFailure.route)?.label ?? signInFailure.route}{' '}
          did not start. {signInFailure.reason}.
        </div>
      ) : null}

      {/* ⚠️ AND WHEN THERE IS NOTHING TO FALL BACK TO. The notice above was the
          only one, gated on a route to name, so the worse case — the chosen
          route gone and nothing else usable — said nothing about the choice at
          all (2026-09-13 audit). */}
      {snapshot.fellBack && snapshot.inUse === null ? (
        <div className={ui.hint}>
          The route you chose is not available, and nothing else can answer. Your choice is remembered and
          will come back when it does.
        </div>
      ) : null}

      {/* ⚠️ THE `Look up` CYCLE ROW WAS HERE — three states, System dictionary
          / Gloss / Both, drawn only when a gloss was available. It is deleted
          with the hand-off it chose between. The reader has nothing to decide:
          the dictionary button glosses the selection, and macOS's own Look Up
          is on the right-click menu where it always was. */}

      {/* NO VOICE PICKER, and it is a removal rather than an omission.
       *
       * It wrote the chosen voice into `companion.route` — the ANSWERING
       * route — through the same `use` the text rows call, so picking a
       * narrator set the companion to a speech model that cannot answer a
       * question. It never fired only because `voiceRows` needed two usable
       * speech models and the manifest ships one, so the defect was held off
       * by an accident of the catalogue rather than by anything structural.
       *
       * Narration does not exist: `Test voice` proves a model and nothing
       * reads it, which the feature ledger records as Absent. A picker with
       * nothing to pick for is the shape-guessed-at-in-advance this pane's
       * own stylesheet was cleaned of once already. It comes back with the
       * feature that needs it, and with selection state of its own. */}

      {/* THE EFFORT, and it is absent rather than disabled unless an agent is
          answering — the two flags it maps to exist on the agent CLIs and
          nowhere else. A cycle, because there are three states and there
          cannot be a fourth.

          (This said "Same shape as Look up above", pointing at a cycle row
          deleted from above it; corrected 2026-09-13, by audit.)

          ⚠️ NAMED BY THE SETTING AS WELL AS THE VALUE. `Effort` is a sibling
          span, so the button's accessible name was its value alone — "Account
          default" — the defect `RouteAction`'s header records for the route
          buttons. The hint is attached for the same reason. */}
      {snapshot.depth !== null ? (
        <>
          <div className={ui.row}>
            <span className={ui.grow}>Effort</span>
            <button
              type="button"
              className={ui.button}
              aria-label={`Effort: ${snapshot.depth}`}
              aria-describedby={effortHint}
              onClick={() => model.cycleDepth()}
            >
              {snapshot.depth}
            </button>
          </div>
          <div id={effortHint} className={ui.hint}>
            How much of your subscription one answer may spend. Faster answers sooner
            and costs less; more thorough thinks for longer.
          </div>
        </>
      ) : null}

      {/* ⚠️ NO `Tools` TOGGLE, and it is a removal rather than an omission.
       *
       * It was persisted, it was drawn, and **nothing on any answer path read
       * it.** The agent turns disable tools unconditionally and the local
       * route has none, so the switch moved a boolean and changed nothing —
       * while telling the reader, in a hint beneath it, that the companion
       * could now reach further and would say when it did.
       *
       * An inert control is bad anywhere; an inert PRIVACY control is worse
       * than none, because it fails convincingly. See `lib/settings.ts`. */}
    </div>
  )
}
