import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { CAPABILITY_UI as ui, type SettingsStore } from '../../../kernel'
import { DEFAULT_GLOSS_PROMPT, GLOSS_PROMPT_SETTING, MAX_GLOSS_PROMPT } from '../lib/glossProvider'
import type { GlossRouteModel, RouteChoice } from './glossRouteModel'

/**
 * The **Look up** section (`inference:gloss`, order 14), rendered by the
 * kernel's Settings pane: WHAT ANSWERS a lookup, and the instructions every
 * lookup sends it, as the reader may rewrite them.
 *
 * # Answers with
 *
 * Since 2026-09-18 a lookup can be answered by the local model, an
 * OpenAI-compatible endpoint, Claude or Codex, and this is where the reader
 * chooses — the section "Choose one" opens when nothing can answer. The list's
 * decisions are `glossRouteModel.ts`'s (tested, no React), the shape the
 * companion's route list already has. It is ABOVE the prompt because it is the
 * bigger decision: the prompt shapes what an answer says, the route decides who
 * writes it and where the reader's words are sent to be written.
 *
 * # The prompt
 *
 * NO MODEL FILE FOR IT, and that is a decision rather than an omission.
 * `ModelsPane` and `StoragePane` have one because they hold state nothing else
 * does — a catalogue, a download ledger, an eviction in flight. The prompt is
 * one string that already lives in the settings store, and the store is a
 * `useSyncExternalStore` pair; a model here would be a second copy of a value
 * with its own idea of when it changed.
 *
 * Drawn with `CAPABILITY_UI`, the kernel's public class vocabulary — nothing
 * here invents a colour, a radius or a height. The editor is `ui.textarea`,
 * which was added for it: `ui.field` is a fixed-height pill and would show one
 * line of a paragraph.
 *
 * # Why the prompt is editable at all
 *
 * `DEFAULT_GLOSS_PROMPT`'s own comment is a record of what was MEASURED — the
 * anti-echo line in particular, which a bare prohibition could not buy and an
 * example did, seven times of seven. That is an argument for a good default,
 * not for a fixed one: a reader whose books are in a language the default
 * serves badly, or who wants a gloss written for a child, has no way to say so,
 * and the string they need to change is eight sentences of English sitting in a
 * TypeScript file. The tests that pin those sentences pin the DEFAULT, so a
 * reader's edit cannot repeal them for anybody else, and Restore default is one
 * press away.
 */
/**
 * One row's control, exhaustively — the companion's `RouteAction`, narrowed to
 * the three a Look up row can need. A route that cannot answer offers nothing
 * to press; its reason is the row's value.
 *
 * ⚠️ **EVERY BUTTON NAMES ITS ROUTE**, for the reason `RouteAction` records: a
 * list of buttons that all say `Use` is a list a screen reader cannot tell
 * apart, because the label beside each is a sibling span and not a `<label>`.
 */
function ChoiceControl({ choice, routes }: { readonly choice: RouteChoice; readonly routes: GlossRouteModel }) {
  switch (choice.action) {
    case 'in-use':
      return <span className={ui.value}>In use</span>
    case 'use':
      return (
        <button type="button" className={ui.button} aria-label={`Answer with ${choice.label}`} onClick={() => routes.use(choice.id)}>
          Use
        </button>
      )
    case 'none':
      return null
  }
  /* A fourth action must be a type error, not a row that silently draws no
     control — `tsc` accepts a switch that falls off its end (`RouteAction`
     measured it). */
  const unreached: never = choice.action
  return unreached
}

/**
 * What answers — the list, whatever it fell back from, and where the words go.
 *
 * Its own component so the prompt editor below does not re-render with every
 * probe and every byte of a download the route list listens to.
 */
function AnswersWith({ routes }: { readonly routes: GlossRouteModel }) {
  const snapshot = useSyncExternalStore(routes.subscribe, routes.getSnapshot)
  /* ASKED WHEN THE SECTION IS OPENED, never on a timer — a probe spawns the
     agent CLIs (`RouteStore`). The section is where a reader comes after
     signing in to Claude or adding an endpoint, so it is the moment the held
     answer is most likely to be stale. `refresh` never rejects; the catch is
     for a promise that someday could. */
  useEffect(() => {
    void routes.refresh().catch(() => {})
  }, [routes])

  return (
    <>
      <div className={ui.row}>
        <span className={ui.grow}>Answers with</span>
        <span className={ui.value}>{snapshot.checking ? 'Checking…' : ''}</span>
      </div>
      {snapshot.choices.map((choice) => (
        <div key={choice.id} className={ui.row}>
          <span className={ui.grow}>{choice.label}</span>
          <span className={ui.value}>{choice.value}</span>
          <ChoiceControl choice={choice} routes={routes} />
        </div>
      ))}
      {/* A CHOICE THAT CANNOT ANSWER IS SAID, NOT SWAPPED SILENTLY — the
          companion's WI-15.11, and the stored choice is kept so it comes back
          by itself. */}
      {snapshot.unavailableChoice === null ? null : (
        <div className={ui.hint}>
          {snapshot.unavailableChoice} can&rsquo;t answer right now, so Look up is answering automatically. Your
          choice is kept, and comes back when it can answer.
        </div>
      )}
      <div className={ui.hint}>{snapshot.where}</div>
    </>
  )
}

export function GlossPromptPane({
  settings,
  routes,
}: {
  readonly settings: SettingsStore
  /** What answers — see `glossRouteModel.ts`. */
  readonly routes: GlossRouteModel
}) {
  /* SUBSCRIBED, although the field below is uncontrolled: the only thing this
     value decides is whether Restore default is offered, and that has to change
     the moment a commit lands rather than at whatever renders next. */
  const stored = useSyncExternalStore(
    settings.subscribe,
    useCallback(() => settings.get(GLOSS_PROMPT_SETTING), [settings]),
  )
  const field = useRef<HTMLTextAreaElement>(null)
  /* The text being typed, or `null` when the field shows what is stored — a
     half-finished decision, which is not a preference yet. A ref rather than
     state because nothing renders from it; re-rendering per keystroke would
     also re-render the section around it. */
  const draft = useRef<string | null>(null)

  /**
   * Hand the draft over, if there is one.
   *
   * ⚠️ **AN EMPTY BOX IS NOT AN EMPTY PROMPT.** A reader who selects all and
   * deletes has cleared the field, not asked for a model with no instructions —
   * and `GLOSS_PROMPT_SETTING`'s parse refuses the empty string anyway, so
   * committing it would store a value that reads back as the default while the
   * box still showed nothing. The field snaps back to what is stored instead,
   * which says plainly that nothing was taken.
   */
  const save = useCallback(() => {
    const text = draft.current
    if (text === null) return
    draft.current = null
    const wanted = text.trim()
    /* TRIMMED HERE SO THE PARSE AND THE PANE AGREE: the parse trims only to
       decide, and stores what it was given, so a prompt committed with a
       trailing newline would be stored with it and come back a character longer
       every time somebody pressed return before leaving. */
    if (wanted === '') {
      if (field.current !== null) field.current.value = settings.get(GLOSS_PROMPT_SETTING)
      return
    }
    settings.set(GLOSS_PROMPT_SETTING, wanted)
  }, [settings])

  /**
   * ⚠️ **BLUR ALONE LOSES THE EDIT, AND SILENTLY** — the trap `Marginalia.tsx`
   * records about the note editor, and this field is in the same position.
   * Closing the settings group, switching panes, opening a book or quitting the
   * window all remove a focused textarea WITHOUT a blur event, so a prompt the
   * reader had just typed went with it and nothing said so.
   *
   * `pagehide` rather than `beforeunload`, for that file's reason: it fires on
   * the path a webview actually takes when the window goes away, and it is not
   * blocked by the conditions that make `beforeunload` unreliable.
   */
  useEffect(() => {
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', save)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', save)
      save()
    }
  },
  // Stryker disable next-line ArrayDeclaration: `save` changes only with the store, which a mounted pane does not swap, so the listeners are added once either way.
  [save])

  const isDefault = stored === DEFAULT_GLOSS_PROMPT

  return (
    <div className={ui.section}>
      <AnswersWith routes={routes} />
      <div className={ui.row}>
        <span className={ui.grow}>What Look up tells the model</span>
        <button
          type="button"
          className={ui.button}
          disabled={isDefault}
          /* KEEPS THE FOCUS IN THE FIELD, the way `Marginalia`'s "Use that
             version" does and for the same reason: a press that took it would
             blur the editor first, and the blur commits the draft — so the
             reader's abandoned text would be stored for the instant before this
             replaced it, and `draft.current` would still be holding it
             afterwards, ready to be committed over the default by the next
             blur. Nothing is committed at all this way. */
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            draft.current = null
            if (field.current !== null) field.current.value = DEFAULT_GLOSS_PROMPT
            settings.set(GLOSS_PROMPT_SETTING, DEFAULT_GLOSS_PROMPT)
          }}
        >
          Restore default
        </button>
      </div>
      <div className={ui.hint}>
        These instructions are sent with every word you look up, ahead of the
        sentence it came from. Changing them changes every answer from here on;
        answers already looked up in this session are forgotten, so the next
        lookup of a word you have seen asks again. They decide what an answer
        says, not how it is laid out: every answer is a part of speech, then
        the meaning in each language Look up answers in, whatever the
        instructions ask for.
      </div>
      <textarea
        ref={field}
        className={ui.textarea}
        /* UNCONTROLLED, with the ref putting a value back on the two occasions
           something other than typing decides what it should be — a restore, and
           a cleared field. Controlled, every keystroke would write the setting,
           which is the defect `StoragePane`'s cover cap records in the small:
           there, typing `250` committed `2` first and evicted almost every
           cover before the second digit landed. */
        defaultValue={stored}
        aria-label="The instructions Look up sends the model"
        /* The parse refuses anything longer, so the field stops the reader
           where the setting does rather than letting them write a prompt that
           is silently discarded on the way to disk. The two agree exactly for
           every script — `maxLength` counts UTF-16 units and the parse counts
           code points, which are the same number for everything inside the
           basic plane — and for the astral characters where they differ this
           one stops sooner, which is the safe direction: the field can never
           hold a prompt the setting would refuse. */
        maxLength={MAX_GLOSS_PROMPT}
        onChange={(event) => {
          draft.current = event.target.value
        }}
        onBlur={save}
      />
    </div>
  )
}
