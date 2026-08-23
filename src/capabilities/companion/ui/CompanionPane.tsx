import { useEffect, useSyncExternalStore } from 'react'
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
  /**
   * Whether this platform has a system dictionary — `lookUp.ts`'s answer,
   * routed through `services.hasDictionary()`.
   *
   * ⚠️ **REQUIRED, AND IT USED TO DEFAULT TO `false`.** The production caller
   * passed nothing, so on macOS — the one platform that HAS a dictionary — it
   * was excluded from the cycle and the reader could not select
   * `System dictionary` or `Both` at all. A default that is wrong on the
   * platform the feature exists for is not a default, and an optional prop is
   * how a caller forgets to answer.
   */
  readonly hasDictionary: boolean
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
}

export function CompanionPane({ model, hasDictionary }: CompanionPaneProps) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
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

      {snapshot.fellBack && snapshot.inUse !== null ? (
        <div className={ui.hint}>
          The route you chose is not available, so the companion is answering with{' '}
          {snapshot.rows.find((row) => row.id === snapshot.inUse)?.label ?? snapshot.inUse}. Your
          choice is remembered and will come back when it does.
        </div>
      ) : null}

      {/* `Look up` is a cycle button and the route list is a list, and that is
          not a contradiction: the list grows, and this has at most three
          states and cannot gain a fourth. Absent entirely when there is no
          gloss to offer — with no model installed, macOS behaves exactly as
          it does today and Windows and Linux still show no control. */}
      {snapshot.lookUp !== null ? (
        <>
          <div className={ui.row}>
            <span className={ui.grow}>Look up</span>
            <button
              type="button"
              className={ui.button}
              onClick={() => model.cycleLookUp(hasDictionary, true)}
            >
              {snapshot.lookUp}
            </button>
          </div>
          <div className={ui.hint}>
            A gloss reads the sentence the word is in, and works on a phrase, where
            the dictionary returns nothing.
          </div>
        </>
      ) : null}

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

      {/* THE EFFORT, and it is absent rather than disabled when a local model
          is answering — the two flags it maps to exist on the agent CLIs and
          nowhere else. Same shape as Look up above: a cycle, because there
          are three states and there cannot be a fourth. */}
      {snapshot.depth !== null ? (
        <>
          <div className={ui.row}>
            <span className={ui.grow}>Effort</span>
            <button type="button" className={ui.button} onClick={() => model.cycleDepth()}>
              {snapshot.depth}
            </button>
          </div>
          <div className={ui.hint}>
            How much of your subscription one answer may spend. Faster answers sooner
            and costs less; more thorough thinks for longer.
          </div>
        </>
      ) : null}

      {/* A `<label>` rather than a sibling `<span>`: the text was next to the
          checkbox and not associated with it, so the control had no accessible
          name at all — a screen reader announced an unlabelled checkbox. The
          same wrapping also makes the word itself a hit target. */}
      <label className={ui.row}>
        <span className={ui.grow}>Tools</span>
        <input
          type="checkbox"
          className={ui.toggle}
          checked={snapshot.tools}
          onChange={(event) => model.setTools(event.currentTarget.checked)}
        />
      </label>
      <div className={ui.hint}>
        The companion answers from the book. Tools let it reach further; it will say
        when it does.
      </div>
    </div>
  )
}
