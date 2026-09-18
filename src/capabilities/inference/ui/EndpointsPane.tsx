import { useEffect, useSyncExternalStore, type ChangeEvent } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import { type EndpointsModel } from './endpointsModel'

/**
 * The **Cloud endpoints** section (`inference:endpoints`, order 16), rendered
 * by the kernel's Settings pane.
 *
 * Decisions live in `endpointsModel.ts` (tested, no React); this adapter draws
 * the snapshot. Drawn with `CAPABILITY_UI`, the kernel's public class
 * vocabulary — nothing here invents a colour, a radius, a height or a control.
 * The form is the shape `DevicesPane` already uses for pairing: a field, a
 * primary button, and a list of rows above it.
 *
 * # Why this exists at all
 *
 * Everything under it was already built and tested — the endpoint file, the
 * key in the OS keychain, the probe route. There was simply no way for a
 * reader to add one, so none of that could ever run in the app, and the
 * feature ledger called it Shipped. An audit found the four commands with no
 * caller anywhere under `src/`.
 *
 * ⚠️ **FOR A WHILE NOTHING CONNECTED ONE AT ALL, AND THE SECTION WAS HIDDEN.**
 * What turned an endpoint into an answer was Lemonade, which took the keys and
 * the providers at spawn; `llama-server` has neither, so every endpoint route
 * reported `notConnected` and this section was offered only under developer
 * options. Paper talks to the endpoint itself now (the gloss routes contract,
 * 2026-09-18), so an endpoint with a key and a model name can answer Look up,
 * and the section is offered to every reader again.
 *
 * # The key is write-only, here as everywhere
 *
 * There is deliberately no command that reads a key back, so this pane cannot
 * show one — only whether one is stored. That is the property WI-15.8's
 * acceptance rests on, and a settings pane is exactly where it would be
 * easiest to undo by "helpfully" displaying what was saved.
 */

export function EndpointsPane({ model }: { readonly model: EndpointsModel }) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  /* ⚠️ **THE MODEL'S, NOT `useState`'s.** `PaneGroup` unmounts a closed group
     deliberately, so component state is exactly as long-lived as the group
     being open — and a reader who pasted an address, went to another group for
     their key and came back found the fields empty. See
     `EndpointsSnapshot.draft`. */
  const draft = snapshot.draft

  useEffect(() => {
    void model.refresh().catch(() => {})
  }, [model])

  /* The form carries no label field: `endpointsModel` falls back to the name,
     and a second name for the same thing is one more thing to type than this
     surface earns. */
  const field =
    (key: 'id' | 'baseUrl' | 'model' | 'key') =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      /* ⚠️ READ NOW, NOT LATER. The synthetic event is pooled and over by the
         time anything deferred runs, and `currentTarget` is null by then — so
         the keystroke arrived as a crash rather than as a character. Found by
         mounting the pane. */
      const { value } = event.currentTarget
      /* TYPING TAKES BACK AN ARMED REMOVAL. The reader is plainly doing
         something else, and a press left armed is one click away from
         deleting a row they are no longer looking at. */
      model.disarm()
      model.edit(key, value)
    }

  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Cloud endpoints</span>
        <span className={ui.value}>{snapshot.loading ? 'Checking…' : ''}</span>
      </div>
      <div className={ui.hint}>
        An OpenAI-compatible endpoint you host or pay for — or one running on this
        computer, at an http://localhost address. Its key is kept in this
        computer&rsquo;s keychain and never read back — not by this pane and not
        by anything else.
      </div>

      {snapshot.rows.map((row) => (
        <div key={row.id} className={ui.row}>
          <span className={ui.grow}>{row.label}</span>
          <span className={`${ui.value} ${ui.code}`}>{row.value}</span>
          {/* TWO PRESSES, because a key cannot be put back — see
              `EndpointRow.action`. The second press is what deletes. */}
          <button
            type="button"
            className={`${ui.button} ${ui.buttonDanger}`}
            disabled={snapshot.busy}
            aria-label={
              row.action === 'confirm' ? `Confirm removing ${row.label}` : `Remove ${row.label}`
            }
            onClick={() => void model.pressRemove(row.id)}
          >
            {row.action === 'confirm' ? 'Really remove?' : 'Remove'}
          </button>
        </div>
      ))}

      {!snapshot.loading && snapshot.rows.length === 0 ? (
        <div className={ui.hint}>None yet. Add one below to answer with it.</div>
      ) : null}

      {/* ONE FIELD PER ROW, each with its label in the `grow` slot — the shape
          `StoragePane` uses. Three `ui.field`s side by side in one row is what
          this was first written as, and in a side pane every one of them
          collapses towards zero: `paper-cap-field` is `flex: 1 1 auto` with
          `min-width: 0`, so three of them share what one was drawn for and the
          address becomes untypeable. `DevicesPane`, the other form in this
          vocabulary, puts one field in a row for the same reason. */}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          /* NO ARGUMENT, and no clearing here either: the draft is the model's,
             and so is the rule that a refused one stays in the fields. */
          void model.save()
        }}
      >
        <div className={ui.row}>
          <span className={ui.grow}>Name</span>
          <input
            value={draft.id}
            onChange={field('id')}
            placeholder="my-proxy"
            aria-label="Endpoint name"
            className={`${ui.field} ${ui.fieldNarrow}`}
          />
        </div>
        <div className={ui.row}>
          <span className={ui.grow}>Address</span>
          <input
            value={draft.baseUrl}
            onChange={field('baseUrl')}
            placeholder="https://…"
            aria-label="Endpoint address"
            className={ui.field}
          />
        </div>
        {/* THE PROVIDER'S NAME FOR THE MODEL, typed rather than picked: an
            OpenAI-compatible server may serve one model or a hundred, and Paper
            asks nothing of it before a lookup does. The row above it names the
            server; this names what to ask it for. */}
        <div className={ui.row}>
          <span className={ui.grow}>Model</span>
          <input
            value={draft.model}
            onChange={field('model')}
            placeholder="gpt-4.1-mini"
            aria-label="Endpoint model name"
            className={ui.field}
          />
        </div>
        <div className={ui.row}>
          <span className={ui.grow}>API key</span>
          {/* `password`, so it is not read over the reader's shoulder or
              captured by a screenshot. It is never read back afterwards — no
              command exists that could. */}
          <input
            value={draft.key}
            onChange={field('key')}
            type="password"
            placeholder="Paste a key"
            aria-label="Endpoint API key"
            className={ui.field}
          />
        </div>
        <div className={ui.actions}>
          {/* The one action this surface is FOR — see `CAPABILITY_UI.button`. */}
          <button type="submit" className={`${ui.button} ${ui.buttonPrimary}`} disabled={snapshot.busy}>
            Save
          </button>
        </div>
      </form>
      <div className={ui.hint}>
        Re-using a name replaces that endpoint and keeps its key, unless you type a
        new one.
      </div>

      {snapshot.failure === null ? null : <div className={ui.hint}>{snapshot.failure}</div>}
    </div>
  )
}
