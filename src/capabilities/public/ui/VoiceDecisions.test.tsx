// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_DECISIONS, type VoiceDecisions } from '../../../kernel'
import type { VoiceDecisionsPort } from '../lib/voicePort'
import { VoiceDecisionsControl } from './VoiceDecisions'

/**
 * The reader's decisions about voices — WI-26.5's surface.
 *
 * What is proven is the control's PROMISES: that a stranger can be silenced;
 * that a silenced voice stays LISTED so it can be un-silenced, even when this
 * book carries nothing of theirs; that a bound voice offers the person's block
 * and the forget beside its own; and — the one that is not a wording choice —
 * that there is no way here to assert a binding, because only the subject may.
 */

afterEach(cleanup)

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const PERSON = 'c'.repeat(64)

const portOver = (decisions: VoiceDecisions, over: Partial<VoiceDecisionsPort> = {}): VoiceDecisionsPort => ({
  decisions: () => Promise.resolve(decisions),
  standing: () => Promise.resolve('stranger'),
  person: () => Promise.resolve(null),
  voicesOf: () => Promise.resolve([]),
  bind: vi.fn(() => Promise.resolve(null)),
  unbind: vi.fn(() => Promise.resolve()),
  blockVoice: vi.fn(() => Promise.resolve()),
  unblockVoice: vi.fn(() => Promise.resolve()),
  blockPerson: vi.fn(() => Promise.resolve()),
  unblockPerson: vi.fn(() => Promise.resolve()),
  subscribe: () => () => {},
  ...over,
})

const button = (name: string | RegExp) => screen.queryByRole('button', { name })

describe('the voice decisions control', () => {
  it('draws nothing at all before the capability has started', () => {
    const { container } = render(<VoiceDecisionsControl heard={[A]} port={null} />)
    expect(container.textContent).toBe('')
  })

  it('says so plainly when this book has carried nothing and nothing is silenced', async () => {
    render(<VoiceDecisionsControl heard={[]} port={portOver(NO_DECISIONS)} />)
    await waitFor(() => expect(screen.queryByText(/Nobody has published anything/u)).not.toBeNull())
    expect(button(/Silence/u)).toBeNull()
  })

  it('offers to silence a stranger this book carried, and calls the port with that voice', async () => {
    const port = portOver(NO_DECISIONS)
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(button('Silence this voice')).not.toBeNull())
    expect(screen.queryByText('a stranger')).not.toBeNull()
    button('Silence this voice')?.click()
    await waitFor(() => expect(port.blockVoice).toHaveBeenCalledWith(A))
  })

  /* ⚠️ **THE ONE THIS SURFACE EXISTS FOR.** Blocking is enforced before
     storage, so a silenced voice leaves nothing in the book's file. A list
     built from what was heard alone would drop it, and the reader could never
     take the silence back. */
  it('lists a silenced voice this book no longer carries, and offers to hear it again', async () => {
    const port = portOver({ ...NO_DECISIONS, blockedVoices: [B] })
    render(<VoiceDecisionsControl heard={[]} port={port} />)
    await waitFor(() => expect(button('Hear this voice again')).not.toBeNull())
    expect(screen.queryByText('silenced')).not.toBeNull()
    button('Hear this voice again')?.click()
    await waitFor(() => expect(port.unblockVoice).toHaveBeenCalledWith(B))
  })

  it('does not offer to silence a voice twice — the state is the port’s, not a local flag', async () => {
    render(<VoiceDecisionsControl heard={[B]} port={portOver({ ...NO_DECISIONS, blockedVoices: [B] })} />)
    await waitFor(() => expect(button('Hear this voice again')).not.toBeNull())
    expect(button('Silence this voice')).toBeNull()
  })

  it('offers the person’s block and the forget beside a bound voice’s own', async () => {
    const port = portOver({
      ...NO_DECISIONS,
      bindings: [{ voice: A, person: PERSON, assertedBy: PERSON, at: 1 }],
    })
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(button('Silence everything from them')).not.toBeNull())
    expect(screen.queryByText(/someone you know/u)).not.toBeNull()
    button('Silence everything from them')?.click()
    await waitFor(() => expect(port.blockPerson).toHaveBeenCalledWith(PERSON))
    button('Forget that this is theirs')?.click()
    await waitFor(() => expect(port.unbind).toHaveBeenCalledWith(A))
  })

  /* ⚠️ **A BLOCKED PERSON KEEPS THEIR BINDINGS** — `blockPerson` says so, and
     the standing has to read as silenced rather than as "someone you know",
     or the reader would be told they are hearing somebody they are not. */
  it('shows a voice bound to a blocked person as silenced, and offers to hear that person again', async () => {
    const port = portOver({
      bindings: [{ voice: A, person: PERSON, assertedBy: PERSON, at: 1 }],
      blockedVoices: [],
      blockedPeople: [PERSON],
    })
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(screen.queryByText('silenced')).not.toBeNull())
    expect(button(/^Hear .* again$/u)).not.toBeNull()
    button(/^Hear .* again$/u)?.click()
    await waitFor(() => expect(port.unblockPerson).toHaveBeenCalledWith(PERSON))
  })

  /* A person silenced with no voice of theirs on this book would otherwise
     have no row at all, and the silence would be unreachable. */
  it('gives a silenced person a row of their own when no voice here is bound to them', async () => {
    const port = portOver({ ...NO_DECISIONS, blockedPeople: [PERSON] })
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(button('Hear them again')).not.toBeNull())
    button('Hear them again')?.click()
    await waitFor(() => expect(port.unblockPerson).toHaveBeenCalledWith(PERSON))
  })

  /* ⚠️ **NOT A WORDING TEST.** `isWellFormed` refuses a binding whose
     `assertedBy` is not the subject; a control that let the reader name a
     person beside a voice would be inventing that assertion. The absence is
     the guarantee, so it is asserted. */
  it('offers no way to assert a binding, because only the subject may', async () => {
    const port = portOver(NO_DECISIONS)
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(button('Silence this voice')).not.toBeNull())
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(button(/bind|belongs|is my/iu)).toBeNull()
    expect(port.bind).not.toHaveBeenCalled()
  })

  /* ⚠️ **READS COMMIT IN COMPLETION ORDER, AND EVERY CHANGE FIRES ONE.** An
     older read landing after a newer one put a silenced voice back on screen as
     un-silenced — the reader is then told they are hearing somebody they have
     silenced, which is the wrong direction for this control to fail in.
     Reproduced by audit. */
  it('ignores a slow earlier read that lands after a newer one', async () => {
    const answers: ((held: VoiceDecisions) => void)[] = []
    let tell = (): void => {}
    const port = portOver(NO_DECISIONS, {
      decisions: () => new Promise<VoiceDecisions>((resolve) => answers.push(resolve)),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(answers).toHaveLength(1))

    /* A change fires the subscription, so a SECOND read starts. */
    tell()
    await waitFor(() => expect(answers).toHaveLength(2))

    /* The newer read answers first: the voice is silenced. */
    answers[1]!({ ...NO_DECISIONS, blockedVoices: [A] })
    await waitFor(() => expect(button('Hear this voice again')).not.toBeNull())

    /* Then the older one lands, saying it is not. It must be ignored. */
    answers[0]!(NO_DECISIONS)
    await new Promise((go) => setTimeout(go, 20))
    expect(
      button('Hear this voice again'),
      'a stale read un-silenced a voice the reader had silenced',
    ).not.toBeNull()
    expect(button('Silence this voice')).toBeNull()
  })

  /* ⚠️ **A FAILURE AFTER A SUCCESS WAS DRAWN AS "NOTHING TO SHOW".** Once a
     read has succeeded the empty branch takes over, and it had no place for an
     error — so a device that stopped being able to read its decisions told the
     reader everything was quiet. */
  it('still reports trouble when the list is empty', async () => {
    let fail = false
    let tell = (): void => {}
    const port = portOver(NO_DECISIONS, {
      decisions: () =>
        fail ? Promise.reject(new Error('voices.json is not a record of decisions')) : Promise.resolve(NO_DECISIONS),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<VoiceDecisionsControl heard={[]} port={port} />)
    await waitFor(() => expect(screen.queryByText(/Nobody has published anything/u)).not.toBeNull())

    fail = true
    tell()
    await waitFor(() => expect(screen.queryByText(/is not a record of decisions/u)).not.toBeNull())
    /* And the reassuring sentence is still there beside it rather than instead
       of it — the list genuinely is empty; what changed is that the device can
       no longer confirm that. */
    expect(screen.queryByText(/Nobody has published anything/u)).not.toBeNull()
  })

  it('says the silence reaches every book, because it does', async () => {
    render(<VoiceDecisionsControl heard={[A]} port={portOver(NO_DECISIONS)} />)
    await waitFor(() => expect(screen.queryByText(/every book on it/u)).not.toBeNull())
  })

  it('shows what went wrong rather than an empty list when a decision cannot be written', async () => {
    const port = portOver(NO_DECISIONS, {
      blockVoice: () => Promise.reject(new Error('this device already holds the 4096 decisions it will keep')),
    })
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(button('Silence this voice')).not.toBeNull())
    button('Silence this voice')?.click()
    await waitFor(() => expect(screen.queryByText(/4096 decisions/u)).not.toBeNull())
  })

  /* ⚠️ **UNREADABLE MUST NOT LOOK LIKE "NOTHING DECIDED".** The port throws
     rather than collapsing the two, and this is the last place that could put
     the collapse back — a reader whose silences are not being applied has to
     be told, or they will hear somebody they silenced with no way to know why. */
  it('says the decisions could not be read, rather than drawing an empty list', async () => {
    const port = portOver(NO_DECISIONS, {
      decisions: () => Promise.reject(new Error('public/voices.json is not a record of decisions')),
    })
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(screen.queryByText(/none of it is being applied/u)).not.toBeNull())
    expect(screen.queryByText(/is not a record of decisions/u)).not.toBeNull()
    expect(screen.queryByText('a stranger')).toBeNull()
    expect(button('Silence this voice')).toBeNull()
  })

  it('re-reads when the port says a decision changed, rather than keeping its own copy', async () => {
    let held: VoiceDecisions = NO_DECISIONS
    let tell = (): void => {}
    const port = portOver(NO_DECISIONS, {
      decisions: () => Promise.resolve(held),
      subscribe: (listener) => {
        tell = listener
        return () => {}
      },
    })
    render(<VoiceDecisionsControl heard={[A]} port={port} />)
    await waitFor(() => expect(button('Silence this voice')).not.toBeNull())
    held = { ...NO_DECISIONS, blockedVoices: [A] }
    tell()
    await waitFor(() => expect(button('Hear this voice again')).not.toBeNull())
  })

  it('keeps the list in one order, so it does not rearrange itself under the reader', async () => {
    const port = portOver({ ...NO_DECISIONS, blockedVoices: [A] })
    render(<VoiceDecisionsControl heard={[B, A]} port={port} />)
    await waitFor(() => expect(button('Hear this voice again')).not.toBeNull())
    const shown = screen.getAllByText(/^[ab]{12}$/u).map((one) => one.textContent)
    expect(shown).toEqual(['a'.repeat(12), 'b'.repeat(12)])
  })
})
