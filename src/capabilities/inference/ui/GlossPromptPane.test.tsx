// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useMemo } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSettingsStore, type SettingsStore } from '../../../kernel'
import type { InferenceSnapshot } from '../lib/controller'
import { DEFAULT_GLOSS_PROMPT, GLOSS_PROMPT_SETTING, MAX_GLOSS_PROMPT } from '../lib/glossProvider'
import { AUTOMATIC, GLOSS_ROUTE_SETTING, createRouteStore } from '../lib/glossRoute'
import type { Route } from '../lib/plugin'
import { GlossPromptPane } from './GlossPromptPane'
import { createGlossRouteModel, type GlossRouteModel } from './glossRouteModel'

/**
 * The Look up section, mounted.
 *
 * Everything this file measures is a decision the PANE makes, because there is
 * no model under it to make them: when a draft is committed, what an empty box
 * means, whether Restore default is offered, and — the one that costs a
 * reader's work when it is wrong — whether an edit survives the pane going
 * away without a blur. `Marginalia.tsx` records that class; a settings section
 * inside a closed `PaneGroup` is in exactly the same position.
 */

afterEach(cleanup)

/** A real settings store over a real (in-memory) storage — this pane's whole world. */
function store(): SettingsStore {
  const held = new Map<string, string>()
  return createSettingsStore({
    storage: {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
    } as unknown as Storage,
  })
}

/**
 * The route list's model, over a probe that answers with `routes` and a local
 * model that is not installed — so nothing but what the probe lists can answer,
 * and every row the list draws is one the test chose.
 */
function routesOver(settings: SettingsStore, routes: readonly Route[] = []): { readonly model: GlossRouteModel; readonly probe: ReturnType<typeof vi.fn> } {
  const probe = vi.fn(async () => ({ routes, runtimeVersion: null }))
  const nothingLocal: InferenceSnapshot = { runtime: { kind: 'installed' }, models: [], installing: null, removing: null, failure: null }
  const model = createGlossRouteModel({
    settings,
    routes: createRouteStore({ plugin: { probe } }),
    controller: { getSnapshot: () => nothingLocal, subscribe: () => () => {}, textModel: () => null },
    plugin: { endpoints: async () => [] },
  })
  return { model, probe }
}

/** The section as the capability mounts it — the prompt tests need no routes, only a list that stays quiet. */
function Pane({ settings }: { readonly settings: SettingsStore }) {
  /* ONE MODEL PER MOUNT, as the capability holds one per lifetime: a model
     built per render would re-subscribe and re-probe on every render. */
  const routes = useMemo(() => routesOver(settings).model, [settings])
  return <GlossPromptPane settings={settings} routes={routes} />
}

const editor = (): HTMLTextAreaElement =>
  screen.getByLabelText('The instructions Look up sends the model') as HTMLTextAreaElement

const restore = (): HTMLButtonElement => screen.getByRole('button', { name: 'Restore default' })

const THEIRS = 'Define the word in one sentence a nine-year-old would understand.'

describe('the Look up prompt editor', () => {
  it('shows what is stored, which is the default until the reader changes it', () => {
    const settings = store()
    render(<Pane settings={settings} />)
    expect(editor().value).toBe(DEFAULT_GLOSS_PROMPT)

    cleanup()
    settings.set(GLOSS_PROMPT_SETTING, THEIRS)
    render(<Pane settings={settings} />)
    expect(editor().value).toBe(THEIRS)
  })

  /* COMMITTED WHEN THE EDIT IS FINISHED, not per keystroke — the defect
     `StoragePane`'s cover cap records: there, every character was written, and
     typing `250` committed `2` first. Here a per-keystroke write would send a
     half-written prompt to the model for as long as the reader kept typing. */
  it('writes nothing while the reader is typing, and writes on blur', () => {
    const settings = store()
    render(<Pane settings={settings} />)
    fireEvent.change(editor(), { target: { value: THEIRS } })
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(DEFAULT_GLOSS_PROMPT)

    fireEvent.blur(editor())
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(THEIRS)
  })

  /**
   * ⚠️ **THE TRAP `Marginalia.tsx` RECORDS.** Closing the settings group,
   * switching panes or quitting the window removes a focused textarea WITHOUT
   * a blur event, so an edit made and not blurred is simply gone — with nothing
   * to say it was not kept.
   */
  it('keeps an edit the reader never blurred, when the pane goes away', () => {
    const settings = store()
    const { unmount } = render(<Pane settings={settings} />)
    fireEvent.change(editor(), { target: { value: THEIRS } })
    unmount()
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(THEIRS)
  })

  it('keeps an edit when the window is put away', () => {
    const settings = store()
    render(<Pane settings={settings} />)
    fireEvent.change(editor(), { target: { value: THEIRS } })
    window.dispatchEvent(new Event('pagehide'))
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(THEIRS)
  })

  it('keeps an edit when the window is hidden', () => {
    const settings = store()
    render(<Pane settings={settings} />)
    fireEvent.change(editor(), { target: { value: THEIRS } })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(THEIRS)
  })

  /**
   * ⚠️ **AN EMPTY BOX IS NOT AN EMPTY PROMPT.** A reader who selects all and
   * deletes has cleared the field, not asked for a model with no instructions —
   * and the parse refuses the empty string anyway, so a commit would store a
   * value that reads back as the default while the box still showed nothing.
   */
  it('snaps back rather than storing an empty prompt', () => {
    const settings = store()
    settings.set(GLOSS_PROMPT_SETTING, THEIRS)
    render(<Pane settings={settings} />)
    fireEvent.change(editor(), { target: { value: '   ' } })
    fireEvent.blur(editor())
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(THEIRS)
    expect(editor().value, 'the field was left empty, saying nothing about what is stored').toBe(THEIRS)
  })

  /* Trimmed on the way in, so the parse and the pane agree about what is
     stored: the parse trims only to DECIDE and keeps what it is given. */
  it('stores a prompt without the whitespace around it', () => {
    const settings = store()
    render(<Pane settings={settings} />)
    fireEvent.change(editor(), { target: { value: `\n  ${THEIRS}  \n` } })
    fireEvent.blur(editor())
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(THEIRS)
  })

  it('stops the reader where the setting does', () => {
    render(<Pane settings={store()} />)
    expect(editor().maxLength).toBe(MAX_GLOSS_PROMPT)
  })
})

describe('restoring the default', () => {
  it('is not offered while the prompt already is the default', () => {
    const settings = store()
    render(<Pane settings={settings} />)
    expect(restore().disabled).toBe(true)
  })

  it('is offered as soon as the reader has changed it, and puts the default back', () => {
    const settings = store()
    render(<Pane settings={settings} />)
    fireEvent.change(editor(), { target: { value: THEIRS } })
    fireEvent.blur(editor())
    expect(restore().disabled, 'the button did not notice the commit').toBe(false)

    fireEvent.click(restore())
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(DEFAULT_GLOSS_PROMPT)
    expect(editor().value).toBe(DEFAULT_GLOSS_PROMPT)
    expect(restore().disabled).toBe(true)
  })

  /**
   * ⚠️ **THE DRAFT THE READER ABANDONED MUST NOT COME BACK AFTERWARDS.** The
   * press keeps the focus in the field (`onMouseDown` preventDefault), so no
   * blur fires and nothing half-typed is committed on the way — but the draft
   * is still in hand, and a later blur would write it straight over the default
   * this button just restored.
   */
  it('forgets a half-typed draft, so the next blur does not undo it', () => {
    const settings = store()
    settings.set(GLOSS_PROMPT_SETTING, THEIRS)
    render(<Pane settings={settings} />)
    fireEvent.change(editor(), { target: { value: 'something half written' } })
    fireEvent.click(restore())
    fireEvent.blur(editor())
    expect(settings.get(GLOSS_PROMPT_SETTING)).toBe(DEFAULT_GLOSS_PROMPT)
  })

  /**
   * The whole point of cancelling the mousedown: in a browser the press moves
   * focus to the button, which blurs the field, and the blur commits — so the
   * text the reader was abandoning would be stored for the instant before the
   * restore replaced it, and a listener would see it.
   *
   * ⚠️ **WHAT THIS CAN AND CANNOT MEASURE.** jsdom does not move focus on
   * mousedown at all, so the blur it prevents cannot be provoked here; what is
   * observable is the CANCELLATION, which is the mechanism. The consequence —
   * nothing half-typed ever reaching the store — is the case above.
   *
   * ⚠️ **AND THE BUTTON HAS TO BE LIVE FOR THIS TO MEASURE ANYTHING.** Written
   * against the default it passed for the wrong reason: React attaches no
   * handler to a disabled button, so the event was uncancelled because there
   * was nothing there to cancel it.
   */
  it('does not let the press itself commit what is in the field', () => {
    const settings = store()
    settings.set(GLOSS_PROMPT_SETTING, THEIRS)
    render(<Pane settings={settings} />)
    expect(restore().disabled, 'a disabled button cancels nothing, so this would measure nothing').toBe(false)
    fireEvent.change(editor(), { target: { value: 'something half written' } })
    expect(fireEvent.mouseDown(restore()), 'the press did not keep the focus where it was').toBe(false)
  })
})

/**
 * ANSWERS WITH — the owner's decision of 2026-09-18, drawn.
 *
 * The list's rules are `glossRouteModel.test.ts`'s; what is measured here is
 * that the section draws them as controls a reader can use: the list is ABOVE
 * the prompt, a route that can answer offers a named `Use`, one that cannot
 * offers nothing and says why, the choice reaches the setting, and the sentence
 * about where the words go is on screen.
 */
describe('choosing what answers', () => {
  const claude: Route = { id: 'agent:claude', kind: 'agent', label: 'Claude', detail: 'Max · 2.1.240', unusable: null, installed: true }
  const codex: Route = { id: 'agent:codex', kind: 'agent', label: 'Codex', detail: null, unusable: 'Signed out', reason: 'signedOut', installed: true }

  const mounted = async (routes: readonly Route[] = [claude, codex]) => {
    const settings = store()
    const { model, probe } = routesOver(settings, routes)
    render(<GlossPromptPane settings={settings} routes={model} />)
    /* The probe the section asks for on mount lands. */
    await act(async () => {
      await Promise.resolve()
    })
    return { settings, probe }
  }

  it('asks for a fresh probe when the section is opened', async () => {
    const { probe } = await mounted()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  /* AND OF A LIST IT IS HANDED LATER — a section drawn for another lifetime's
     model asks that model, not only the one it was first given. */
  it('asks the list it is handed now, not only the one it was first given', async () => {
    const settings = store()
    const first = routesOver(settings)
    const { rerender } = render(<GlossPromptPane settings={settings} routes={first.model} />)
    const second = routesOver(settings)
    rerender(<GlossPromptPane settings={settings} routes={second.model} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(second.probe).toHaveBeenCalledTimes(1)
  })

  /* WHILE THE PROBE IS OUT the list may be about to change, and says so. */
  it('says it is checking while the probe is out, and nothing once it has answered', async () => {
    const settings = store()
    let land: () => void = () => {}
    const nothingLocal: InferenceSnapshot = { runtime: { kind: 'installed' }, models: [], installing: null, removing: null, failure: null }
    const model = createGlossRouteModel({
      settings,
      routes: createRouteStore({
        plugin: { probe: () => new Promise((resolve) => (land = () => resolve({ routes: [claude], runtimeVersion: null }))) },
      }),
      controller: { getSnapshot: () => nothingLocal, subscribe: () => () => {}, textModel: () => null },
      plugin: { endpoints: async () => [] },
    })
    render(<GlossPromptPane settings={settings} routes={model} />)
    expect(screen.getByText('Checking…')).toBeTruthy()
    await act(async () => {
      land()
      await Promise.resolve()
    })
    expect(screen.queryByText('Checking…')).toBeNull()
  })

  /* ABOVE THE PROMPT: which route writes the answer, and where the reader's
     words go to have it written, is the bigger decision of the two. */
  it('draws the choice above the instructions', async () => {
    await mounted()
    const heading = screen.getByText('Answers with')
    expect(heading.compareDocumentPosition(editor()) & Node.DOCUMENT_POSITION_FOLLOWING, 'the list is not above the prompt').toBeTruthy()
  })

  it('offers a named Use on a route that can answer, and nothing on one that cannot, saying why', async () => {
    await mounted()
    expect(screen.getByRole('button', { name: 'Answer with Claude' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Answer with Codex' }), 'a route that cannot answer offered a control').toBeNull()
    expect(screen.getByText('Signed out')).toBeTruthy()
    /* AUTOMATIC IS IN USE and says which route it means today. */
    expect(screen.getByText('In use')).toBeTruthy()
  })

  it('stores the reader’s choice, and marks it in use', async () => {
    const { settings } = await mounted()
    fireEvent.click(screen.getByRole('button', { name: 'Answer with Claude' }))
    expect(settings.get(GLOSS_ROUTE_SETTING)).toBe('agent:claude')
    expect(screen.getByRole('button', { name: 'Answer with Automatic' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Answer with Claude' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Answer with Automatic' }))
    expect(settings.get(GLOSS_ROUTE_SETTING)).toBe(AUTOMATIC)
  })

  it('says where the words go, for the route answering now', async () => {
    await mounted()
    expect(screen.getByText('Each word you look up, with its sentence and the book’s title, is sent to Anthropic through your signed-in CLI.')).toBeTruthy()
  })

  /* A CHOICE THAT CANNOT ANSWER IS SAID, NOT SWAPPED SILENTLY. */
  it('says so when the reader’s choice cannot answer', async () => {
    const settings = store()
    settings.set(GLOSS_ROUTE_SETTING, 'agent:codex')
    const { model } = routesOver(settings, [claude, codex])
    render(<GlossPromptPane settings={settings} routes={model} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText(/Codex can’t answer right now, so Look up is answering automatically/)).toBeTruthy()
  })

  it('says what would make something answer, when nothing can', async () => {
    await mounted([codex])
    expect(screen.getByText(/^Nothing can answer yet\. Install a model in Local models/)).toBeTruthy()
  })
})
