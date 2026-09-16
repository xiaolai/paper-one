// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompanionPane } from './CompanionPane'
import type { RouteRow, RoutesModel, RoutesSnapshot } from './routesModel'

/**
 * The Companion section, mounted — for what the pure model cannot show: what
 * the reader is TOLD when a snapshot leaves nothing to press.
 *
 * `routesModel.test.ts` decides the rows; this is the adapter that draws them,
 * and it had no test at all. The two states below drew a heading and nothing
 * else — no reason, no way to ask again — which is the disabled-and-silent
 * shape §07 rules out everywhere else in this pane.
 */

const CODEX: RouteRow = { id: 'agent:codex', label: 'Codex', value: 'Signed in', action: 'in-use' }
const CLAUDE: RouteRow = { id: 'agent:claude', label: 'Claude', value: 'Not installed', action: 'none' }

function snapshotWith(over: Partial<RoutesSnapshot> = {}): RoutesSnapshot {
  return { rows: [], signInFailure: null, inUse: null, fellBack: false, depth: null, loading: false, ...over }
}

/** A model whose snapshot the test sets; every verb a control can press is watched. */
function fakeModel(snapshot: RoutesSnapshot) {
  const refresh = vi.fn(async () => {})
  const use = vi.fn((_id: string) => {})
  const signIn = vi.fn(async (_id: string) => {})
  const cycleDepth = vi.fn(() => {})
  const model: RoutesModel = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh,
    use,
    signIn,
    cycleDepth,
    dispose: () => {},
  }
  return { model, refresh, use, signIn, cycleDepth }
}

/** The row drawn for a route, found by its label. */
const rowOf = (label: string): HTMLElement => screen.getByText(label).parentElement!

afterEach(cleanup)

describe('the Companion pane', () => {
  /* A probe that FAILED is absorbed into an empty list (`routesModel.refresh`),
     so this is also what a dead plugin looks like — and the pane drew only
     "Answers with". The one thing a reader can do about either is ask again. */
  it('says when nothing was found to answer with, and offers to check again', () => {
    const { model, refresh } = fakeModel(snapshotWith())
    render(<CompanionPane model={model} />)

    expect(screen.getByText('Nothing found to answer with')).toBeTruthy()
    expect(refresh, 'the pane did not ask on mount, so the count below proves nothing').toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Check again for something to answer with' }))
    expect(refresh, 'the offer to check again asked nothing').toHaveBeenCalledTimes(2)
  })

  /* Non-vacuity for the case above: before the first answer the list is empty
     too, and "nothing found" would be a claim nobody had checked yet. */
  it('says nothing about an empty list while the first check is still out', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ loading: true })).model} />)
    expect(screen.getByText('Checking…')).toBeTruthy()
    expect(screen.queryByText('Nothing found to answer with')).toBeNull()
  })

  it('names the route it fell back to', () => {
    render(
      <CompanionPane model={fakeModel(snapshotWith({ rows: [CODEX, CLAUDE], inUse: CODEX.id, fellBack: true })).model} />,
    )
    expect(screen.getByText(/so the companion is answering with Codex/)).toBeTruthy()
  })

  /* ⚠️ THE FALL-BACK NOTICE WAS GATED ON THERE BEING SOMETHING TO FALL BACK
     TO, so the worse case — the chosen route gone and nothing else usable —
     said nothing at all about the choice. */
  it('says the chosen route is gone when nothing else can answer either', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CLAUDE], inUse: null, fellBack: true })).model} />)
    expect(screen.getByText(/The route you chose is not available, and nothing else can answer/)).toBeTruthy()
    expect(screen.queryByText(/so the companion is answering with/)).toBeNull()
  })

  /* ⚠️ A LOGIN THAT WOULD NOT LAUNCH SAID SO IN THE LOG AND NOWHERE ELSE. The
     row returns to `Sign in…`, which is also what an ignored press looks like,
     so the reader's next move was to press it again. The route is NAMED,
     because a list of several has no other way to say which one. */
  it('says which route would not open for signing in, and why', () => {
    render(
      <CompanionPane
        model={
          fakeModel(
            snapshotWith({
              rows: [CODEX, CLAUDE],
              signInFailure: { route: CLAUDE.id, reason: 'That agent is not installed' },
            }),
          ).model
        }
      />,
    )
    expect(screen.getByText('Signing in to Claude did not start. That agent is not installed.')).toBeTruthy()
  })

  /* Non-vacuity: nothing says it without a failure to say it about. */
  it('says nothing about signing in when nothing refused to open', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CODEX] })).model} />)
    expect(screen.queryByText(/did not start/)).toBeNull()
  })

  /* ⚠️ THE EFFORT BUTTON WAS NAMED BY ITS VALUE ALONE — "Account default" —
     with `Effort` a sibling span and the hint unattached, which is the exact
     defect `RouteAction`'s header records for the route buttons. */
  it('names the effort button by its setting, and describes it with its hint', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CODEX], inUse: CODEX.id, depth: 'Account default' })).model} />)
    expect(
      screen.getByRole('button', { name: 'Effort: Account default', description: /How much of your subscription/ }),
    ).toBeTruthy()
  })

  it('advances the effort when the effort button is pressed', () => {
    const { model, cycleDepth } = fakeModel(snapshotWith({ rows: [CODEX], inUse: CODEX.id, depth: 'Account default' }))
    render(<CompanionPane model={model} />)
    fireEvent.click(screen.getByRole('button', { name: 'Effort: Account default' }))
    expect(cycleDepth).toHaveBeenCalledTimes(1)
  })

  /* ABSENT, NOT INERT: a local model has neither flag the effort maps to. */
  it('offers no effort control when no agent is answering', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CODEX], inUse: CODEX.id, depth: null })).model} />)
    expect(screen.queryByText('Effort')).toBeNull()
    expect(screen.queryByRole('button', { name: /Effort/ })).toBeNull()
  })

  /* ── ONE ROUTE'S CONTROL, PER ACTION ─────────────────────────────────────
     Each row is its label, its value and exactly the control its action
     names — and every button says which route it belongs to. */

  it('marks the route in use as In use, and offers nothing to press on it', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CODEX], inUse: CODEX.id })).model} />)
    expect(rowOf('Codex').textContent).toBe('CodexSigned inIn use')
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.queryByText('Nothing found to answer with')).toBeNull()
  })

  it('offers Use on a route that can answer, and pressing it chooses that route', () => {
    const qwen: RouteRow = { id: 'local:qwen', label: 'Qwen3-4B', value: 'local · 2.5 GB', action: 'use' }
    const { model, use } = fakeModel(snapshotWith({ rows: [CODEX, qwen], inUse: CODEX.id }))
    render(<CompanionPane model={model} />)
    expect(rowOf('Qwen3-4B').textContent).toBe('Qwen3-4Blocal · 2.5 GBUse')
    fireEvent.click(screen.getByRole('button', { name: 'Use Qwen3-4B' }))
    expect(use.mock.calls).toEqual([['local:qwen']])
  })

  it('offers to sign in to a signed-out agent, and pressing it starts that agent’s login', () => {
    const claude: RouteRow = { id: 'agent:claude', label: 'Claude', value: 'Signed out', action: 'sign-in' }
    const { model, signIn } = fakeModel(snapshotWith({ rows: [claude] }))
    render(<CompanionPane model={model} />)
    expect(rowOf('Claude').textContent).toBe('ClaudeSigned outSign in…')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Claude' }))
    expect(signIn.mock.calls).toEqual([['agent:claude']])
  })

  it('offers to check again while a login is open, and pressing it asks again', () => {
    const claude: RouteRow = { id: 'agent:claude', label: 'Claude', value: 'Waiting for sign-in…', action: 'check-again' }
    const { model, refresh } = fakeModel(snapshotWith({ rows: [claude] }))
    render(<CompanionPane model={model} />)
    expect(rowOf('Claude').textContent).toBe('ClaudeWaiting for sign-in…Check again')
    expect(refresh, 'the pane did not ask on mount, so the count below proves nothing').toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Check whether Claude is signed in' }))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('sends a model that is not installed to Local models rather than offering Use', () => {
    const gemma: RouteRow = { id: 'local:gemma', label: 'Gemma', value: 'Not installed', action: 'install' }
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [gemma] })).model} />)
    expect(rowOf('Gemma').textContent).toBe('GemmaNot installedInstall in Local models')
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('offers nothing on a route nothing here can fix', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CLAUDE] })).model} />)
    expect(rowOf('Claude').textContent).toBe('ClaudeNot installed')
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  /* ── WHAT IS SAID ABOUT THE CHOICE ──────────────────────────────────────── */

  it('says nothing beside Answers with once the check is back', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CODEX], inUse: CODEX.id })).model} />)
    expect(rowOf('Answers with').textContent).toBe('Answers with')
  })

  it('says nothing about the chosen route when the reader never chose one', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CLAUDE], inUse: null, fellBack: false })).model} />)
    expect(screen.queryByText(/The route you chose is not available/)).toBeNull()
  })

  /* BY THAT ROUTE'S OWN LABEL, wherever it sits: the list is in the probe's
     order, and the route answering need not be first in it. */
  it('names the route it fell back to by its own label, wherever it sits in the list', () => {
    render(
      <CompanionPane model={fakeModel(snapshotWith({ rows: [CLAUDE, CODEX], inUse: CODEX.id, fellBack: true })).model} />,
    )
    expect(screen.getByText(/so the companion is answering with Codex\./)).toBeTruthy()
    expect(screen.queryByText(/nothing else can answer/)).toBeNull()
  })

  /* The snapshot is the pane's contract, and a route it names need not be a
     row: named by its id rather than drawn as nothing, or not drawn at all. */
  it('names a route by its id when no row carries it', () => {
    render(<CompanionPane model={fakeModel(snapshotWith({ rows: [CLAUDE], inUse: 'agent:codex', fellBack: true })).model} />)
    expect(screen.getByText(/so the companion is answering with agent:codex\./)).toBeTruthy()
  })

  /* REACHABLE: `routesModel` carries a sign-in failure before the first probe
     has drawn a single row. */
  it('says which route would not open for signing in even before there are rows to name it by', () => {
    render(
      <CompanionPane
        model={
          fakeModel(
            snapshotWith({ loading: true, signInFailure: { route: 'agent:codex', reason: 'Something went wrong' } }),
          ).model
        }
      />,
    )
    expect(screen.getByText('Signing in to agent:codex did not start. Something went wrong.')).toBeTruthy()
  })

  /* A pane handed another model asks THAT one: a probe of the old model would
     leave the new one loading until the group was closed and opened again. */
  it('asks the model it is given, when it is given another', () => {
    const first = fakeModel(snapshotWith())
    const second = fakeModel(snapshotWith())
    const { rerender } = render(<CompanionPane model={first.model} />)
    rerender(<CompanionPane model={second.model} />)
    expect(first.refresh).toHaveBeenCalledTimes(1)
    expect(second.refresh, 'the new model was never asked').toHaveBeenCalledTimes(1)
  })
})
