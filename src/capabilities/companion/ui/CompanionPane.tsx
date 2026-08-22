import { useEffect, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui } from '../../../kernel'
import type { RoutesModel } from './routesModel'

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
  /** Whether this platform has a system dictionary — `lookUp.ts`'s answer. */
  readonly hasDictionary?: boolean
}

export function CompanionPane({ model, hasDictionary = false }: CompanionPaneProps) {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot)
  useEffect(() => {
    void model.refresh()
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
          {row.action === 'in-use' ? (
            <span className={ui.value}>In use</span>
          ) : row.action === 'use' ? (
            <button type="button" className={ui.button} onClick={() => model.use(row.id)}>
              Use
            </button>
          ) : row.action === 'sign-in' ? (
            <button type="button" className={ui.button} onClick={() => void model.signIn(row.id)}>
              Sign in…
            </button>
          ) : row.action === 'install' ? (
            /* A local model that is not installed carries `Install` instead of
               `Use`, so one list does provisioning and selection without
               becoming two. The Local models section owns the download. */
            <span className={ui.value}>Install in Local models</span>
          ) : null}
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

      {snapshot.voices.length > 0 ? (
        <>
          <div className={ui.row}>
            <span className={ui.grow}>Reads aloud with</span>
          </div>
          {snapshot.voices.map((voice) => (
            <div key={voice.id} className={ui.row}>
              <span className={ui.grow}>{voice.label}</span>
              {voice.action === 'in-use' ? (
                <span className={ui.value}>In use</span>
              ) : (
                <button type="button" className={ui.button} onClick={() => model.use(voice.id)}>
                  Use
                </button>
              )}
            </div>
          ))}
        </>
      ) : null}

      <div className={ui.row}>
        <span className={ui.grow}>Tools</span>
        <input
          type="checkbox"
          className={ui.toggle}
          checked={snapshot.tools}
          onChange={(event) => model.setTools(event.currentTarget.checked)}
        />
      </div>
      <div className={ui.hint}>
        The companion answers from the book. Tools let it reach further; it will say
        when it does.
      </div>
    </div>
  )
}
