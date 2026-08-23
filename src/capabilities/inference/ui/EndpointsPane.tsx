import { useEffect, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import { EMPTY_DRAFT, type EndpointsModel } from './endpointsModel'

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
 * key in the OS keychain, the provisioning into the daemon's environment at
 * spawn, the per-start registration, the probe route and `resolve_model`'s
 * acceptance of it. There was simply no way for a reader to add one, so none
 * of that could ever run in the app, and the feature ledger called it Shipped.
 * An audit found the four commands with no caller anywhere under `src/`.
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
  const [draft, setDraft] = useState(EMPTY_DRAFT)

  useEffect(() => {
    void model.refresh().catch(() => {})
  }, [model])

  /* The form carries no label field: `endpointsModel` falls back to the name,
     and a second name for the same thing is one more thing to type than this
     surface earns. */
  const field =
    (key: 'id' | 'baseUrl' | 'key') =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      /* ⚠️ READ NOW, NOT INSIDE THE UPDATER. `setDraft`'s callback runs when
         React chooses to, by which time the synthetic event is over and
         `currentTarget` is null — so the keystroke arrived as a crash rather
         than as a character. Found by mounting the pane. */
      const { value } = event.currentTarget
      /* TYPING TAKES BACK AN ARMED REMOVAL. The reader is plainly doing
         something else, and a press left armed is one click away from
         deleting a row they are no longer looking at. */
      model.disarm()
      setDraft((was) => ({ ...was, [key]: value }))
    }

  return (
    <div className={ui.section}>
      <div className={ui.row}>
        <span className={ui.grow}>Cloud endpoints</span>
        <span className={ui.value}>{snapshot.loading ? 'Checking…' : ''}</span>
      </div>
      <div className={ui.hint}>
        An OpenAI-compatible endpoint you host or pay for. Its key is kept in this
        computer&rsquo;s keychain, handed to the local runtime when it starts, and
        never read back — not by this pane and not by anything else.
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
          void model.save(draft).then((saved) => {
            /* CLEARED ONLY ON SUCCESS. A refused draft stays in the fields so
               the reader can correct the one thing that was wrong, rather than
               retyping an address and a key they have already pasted once. */
            if (saved) setDraft(EMPTY_DRAFT)
          })
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
        new one. Saving or removing restarts the local runtime, so an answer in
        progress will stop.
      </div>

      {snapshot.failure === null ? null : <div className={ui.hint}>{snapshot.failure}</div>}
    </div>
  )
}
