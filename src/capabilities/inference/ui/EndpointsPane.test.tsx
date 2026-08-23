// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { EndpointsPane } from './EndpointsPane'
import type { EndpointDraft, EndpointsModel, EndpointsSnapshot } from './endpointsModel'

/**
 * The Cloud endpoints section, mounted.
 *
 * Several decisions this pane makes are not the model's, and the reason it
 * exists at all is that this whole surface had no caller: the four endpoint
 * commands were built, permitted and never invoked from anywhere under `src/`.
 * So what a reader can actually reach is exactly what was missing, and it is
 * what this file exercises — the accessible names on two buttons that
 * otherwise read alike, the key field being a password, the draft surviving a
 * refusal, and typing taking back an armed removal.
 */

const EMPTY: EndpointsSnapshot = { rows: [], loading: false, busy: false, failure: null }

const row = (over: Partial<EndpointsSnapshot['rows'][number]> & { id: string }) => ({
  label: over.id,
  value: 'api.example.com · key set',
  hasKey: true,
  action: 'remove' as const,
  ...over,
})

/** A model whose snapshot the test sets, recording what the pane asked for. */
function fakeModel(over: Partial<EndpointsSnapshot> = {}) {
  let snapshot: EndpointsSnapshot = { ...EMPTY, ...over }
  const listeners = new Set<() => void>()
  const saved: EndpointDraft[] = []
  const pressed: string[] = []
  let disarms = 0
  let refreshes = 0
  let accept = true
  const model: EndpointsModel = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh: async () => void (refreshes += 1),
    save: async (draft) => {
      saved.push(draft)
      return accept
    },
    pressRemove: async (id) => void pressed.push(id),
    disarm: () => void (disarms += 1),
    dispose: () => {},
  }
  return {
    model,
    saved,
    pressed,
    disarms: () => disarms,
    refreshes: () => refreshes,
    refuse: () => void (accept = false),
    set: (next: Partial<EndpointsSnapshot>) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of [...listeners]) listener()
    },
  }
}

afterEach(cleanup)

describe('the Cloud endpoints pane', () => {
  it('reads the list when it mounts', async () => {
    const world = fakeModel()
    render(<EndpointsPane model={world.model} />)
    await waitFor(() => expect(world.refreshes()).toBe(1))
  })

  it('says there are none rather than showing an empty section', () => {
    render(<EndpointsPane model={fakeModel().model} />)
    expect(screen.getByText(/none yet/i)).toBeTruthy()
  })

  /* NOT WHILE IT IS STILL LOOKING. "None yet" over a list that has not been
     read is an invitation to add a duplicate. */
  it('says nothing about emptiness while it is still reading', () => {
    render(<EndpointsPane model={fakeModel({ loading: true }).model} />)
    expect(screen.queryByText(/none yet/i)).toBeNull()
    expect(screen.getByText('Checking…')).toBeTruthy()
  })

  it('draws a row per endpoint, saying the host and whether a key is stored', () => {
    const world = fakeModel({
      rows: [row({ id: 'a', label: 'My proxy' }), row({ id: 'b', value: 'other.example.com · no key', hasKey: false })],
    })
    render(<EndpointsPane model={world.model} />)
    expect(screen.getByText('My proxy')).toBeTruthy()
    expect(screen.getByText('api.example.com · key set')).toBeTruthy()
    expect(screen.getByText('other.example.com · no key')).toBeTruthy()
  })

  /**
   * ⚠️ EVERY REMOVE BUTTON NAMES ITS ROW.
   *
   * They all read "Remove", and the label beside them is a sibling `<span>`,
   * not a `<label>` — so without this a screen reader announces a list of
   * identical destructive buttons with no way to tell which endpoint any of
   * them would delete. The same defect this pane's sibling had.
   */
  it('names the endpoint each Remove button would delete', () => {
    const world = fakeModel({ rows: [row({ id: 'a', label: 'My proxy' }), row({ id: 'b', label: 'Other' })] })
    render(<EndpointsPane model={world.model} />)
    expect(screen.getByLabelText('Remove My proxy')).toBeTruthy()
    expect(screen.getByLabelText('Remove Other')).toBeTruthy()
  })

  /* TWO PRESSES, because a key cannot be put back: Paper never reads one, so
     it cannot restore one. The second press is what deletes, and the button
     says so before it does. */
  it('says what the armed button is about to do, and names it too', () => {
    const world = fakeModel({ rows: [row({ id: 'a', label: 'My proxy', action: 'confirm' })] })
    render(<EndpointsPane model={world.model} />)
    expect(screen.getByText('Really remove?')).toBeTruthy()
    expect(screen.getByLabelText('Confirm removing My proxy')).toBeTruthy()
  })

  it('presses through to the model, by id', () => {
    const world = fakeModel({ rows: [row({ id: 'a', label: 'My proxy' })] })
    render(<EndpointsPane model={world.model} />)
    fireEvent.click(screen.getByLabelText('Remove My proxy'))
    expect(world.pressed).toEqual(['a'])
  })

  it('sends the whole draft when it is saved', () => {
    const world = fakeModel()
    render(<EndpointsPane model={world.model} />)
    fireEvent.change(screen.getByLabelText('Endpoint name'), { target: { value: 'my-proxy' } })
    fireEvent.change(screen.getByLabelText('Endpoint address'), { target: { value: 'https://api.example.com' } })
    fireEvent.change(screen.getByLabelText('Endpoint API key'), { target: { value: 'sk-secret' } })
    fireEvent.click(screen.getByText('Save'))

    expect(world.saved).toEqual([
      { id: 'my-proxy', label: '', baseUrl: 'https://api.example.com', key: 'sk-secret' },
    ])
  })

  /**
   * ⚠️ THE KEY FIELD IS A PASSWORD FIELD.
   *
   * It is the one thing on this pane that must not be read over a shoulder or
   * captured by a screenshot — and it is never read back afterwards, because
   * no command exists that could. A pane is exactly where that property would
   * be easiest to undo by "helpfully" showing what was saved.
   */
  it('does not show the key while it is being typed', () => {
    render(<EndpointsPane model={fakeModel().model} />)
    expect(screen.getByLabelText('Endpoint API key').getAttribute('type')).toBe('password')
  })

  /* CLEARED ONLY ON SUCCESS. A refused draft stays in the fields so the reader
     corrects the one thing that was wrong, rather than retyping an address and
     a key they have already pasted once. */
  it('keeps a refused draft in the fields, and clears an accepted one', async () => {
    const world = fakeModel()
    world.refuse()
    render(<EndpointsPane model={world.model} />)
    const address = screen.getByLabelText('Endpoint address') as HTMLInputElement
    fireEvent.change(screen.getByLabelText('Endpoint name'), { target: { value: 'my-proxy' } })
    fireEvent.change(address, { target: { value: 'http://insecure' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(world.saved).toHaveLength(1))
    expect(address.value, 'a refused draft was thrown away').toBe('http://insecure')
  })

  it('clears the fields once a draft is accepted', async () => {
    const world = fakeModel()
    render(<EndpointsPane model={world.model} />)
    const address = screen.getByLabelText('Endpoint address') as HTMLInputElement
    fireEvent.change(screen.getByLabelText('Endpoint name'), { target: { value: 'my-proxy' } })
    fireEvent.change(address, { target: { value: 'https://api.example.com' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(address.value).toBe(''))
  })

  /* TYPING TAKES BACK AN ARMED REMOVAL: the reader is plainly doing something
     else, and a press left armed is one click from deleting a row they are no
     longer looking at. */
  it('disarms a pending removal as soon as the reader types', () => {
    const world = fakeModel({ rows: [row({ id: 'a', action: 'confirm' })] })
    render(<EndpointsPane model={world.model} />)
    fireEvent.change(screen.getByLabelText('Endpoint name'), { target: { value: 'x' } })
    expect(world.disarms()).toBe(1)
  })

  it('shows a failure in the reader’s words', () => {
    const world = fakeModel({ failure: 'That endpoint could not be saved.' })
    render(<EndpointsPane model={world.model} />)
    expect(screen.getByText('That endpoint could not be saved.')).toBeTruthy()
  })

  /* NOTHING IS PRESSABLE WHILE A MUTATION IS IN FLIGHT — both commands restart
     the runtime, and two at once would race the same file. */
  it('disables Save and Remove while one is running', () => {
    const world = fakeModel({ rows: [row({ id: 'a', label: 'My proxy' })], busy: true })
    render(<EndpointsPane model={world.model} />)
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Remove My proxy') as HTMLButtonElement).disabled).toBe(true)
  })

  /**
   * ⚠️ ONE FIELD PER ROW.
   *
   * The first draft of this pane put the name, the address and the key in ONE
   * `paper-cap-row` beside the button. `paper-cap-field` is `flex: 1 1 auto`
   * with `min-width: 0`, so in a side pane three of them share the width one
   * was drawn for and the address becomes untypeable. Both other forms in this
   * vocabulary — `DevicesPane` and `StoragePane` — put one field in a row, and
   * this is what keeps that true here.
   */
  it('gives each field a row of its own', () => {
    const { container } = render(<EndpointsPane model={fakeModel().model} />)
    for (const row of container.querySelectorAll('.paper-cap-row')) {
      expect(
        row.querySelectorAll('input').length,
        `a row holds ${row.querySelectorAll('input').length} fields: ${row.textContent ?? ''}`,
      ).toBeLessThanOrEqual(1)
    }
  })
})
