// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Definition, GlossContext, GlossProvider } from '../../core/gloss'
import { buildFixture, elem, txt, type Fixture } from '../reader/wordSnap/domFake.testkit'
import { askGloss, glossRequest, sentenceAround, useGloss, type GlossSelection, type GlossState } from './useGloss'

/**
 * WHAT THE MODEL IS ACTUALLY SENT — asserted at the provider, which is the only
 * place the whole path can be seen at once.
 *
 * §C3 is the reason this is a provider spy and not a unit test of
 * `sentenceAt`. Revision 1 of the plan had `sentenceAt` return
 * `{sentence, complete, blockTruncated}` and let the caller decide; it had no
 * caller that could, because `GlossContext.sentence` is a bare string and
 * `ask()` takes strings. The flags would have been computed, ignored, and the
 * fragment sent anyway — **and every test of the extractor would still have
 * passed.** Only a test that watches the provider can tell "it declined" from
 * "it declined and the caller sent the fragment regardless".
 *
 * `domFake.testkit.ts` supplies the tree rather than jsdom, for the reason its
 * header gives: it refuses duplicate text nodes, so walking the wrong node
 * always changes the answer. jsdom is here only because `useGloss` is a React
 * hook.
 */

afterEach(cleanup)

const ENGLISH = { tag: 'en', name: 'English', label: 'English' } as const
const MODELS = 'inference:models'
/** What every ask carries besides the passage — see `AskGlossContext`. */
const CONTEXT = { bookTitle: 'Moby-Dick', answerIn: () => [ENGLISH] as const }

/** A `Range` as `sentenceAt` reads one: four fields and nothing else. */
function rangeOf(
  fixture: Fixture,
  start: readonly [string, number],
  end: readonly [string, number],
): Range {
  return {
    startContainer: fixture.text(start[0]),
    startOffset: start[1],
    endContainer: fixture.text(end[0]),
    endOffset: end[1],
  } as unknown as Range
}

function selectionOf(
  fixture: Fixture,
  text: string,
  start: readonly [string, number],
  end: readonly [string, number],
  context: { prefix: string; suffix: string },
): GlossSelection {
  return { text, prefix: context.prefix, suffix: context.suffix, range: rangeOf(fixture, start, end) }
}

/** A provider that records what it was asked and answers nothing useful. */
function spyProvider(): {
  provider: GlossProvider
  seen: { term: string; context: GlossContext }[]
  /** How many times the hook asked it to get ready — see `GlossProvider.warm`. */
  warmed: () => number
} {
  const seen: { term: string; context: GlossContext }[] = []
  let warmed = 0
  return {
    seen,
    warmed: () => warmed,
    provider: {
      available: true,
      installAt: MODELS,
      warm() {
        warmed += 1
      },
      async gloss(term, context) {
        seen.push({ term, context })
        return { text: 'a definition' }
      },
    },
  }
}

/** The whole path: the request the wiring builds, through the hook, to the
 *  provider — so nothing between them can quietly substitute a different one. */
async function askThrough(
  selection: GlossSelection,
  options: Partial<Parameters<typeof askGloss>[2]> = {},
) {
  const { provider, seen } = spyProvider()
  const { result } = renderHook(() => useGloss(provider))
  /* Through `askGloss`, the whole handler `useLookUp` calls — not through
   * `glossRequest` on its own. Driving the decision function directly left the
   * step that turns a request into a provider call untested, which an audit
   * pointed out is most of what the wiring IS. */
  await act(async () => {
    askGloss(result.current, selection, {
      fixedLayout: false,
      ...CONTEXT,
      ...options,
    })
  })
  return { seen }
}

describe('what the provider receives', () => {
  /*
   * The ordinary case, and the whole point of the phase: the sentence rather
   * than a 32-character window a side. The `prefix`/`suffix` handed in are the
   * ones `markContext` would really have stored, and they are DELIBERATELY
   * wrong-looking — the fallback built from them starts mid-word, which is the
   * defect being fixed.
   */
  it('is sent the sentence the term sits in, not the stored window', async () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('First one. The old man had taught the boy to fish and the boy loved him. Last one.'),
      ]),
    )
    const whole =
      'First one. The old man had taught the boy to fish and the boy loved him. Last one.'
    const { seen } = await askThrough(
      selectionOf(fixture, 'loved', [whole, 62], [whole, 67], {
        /* Exactly what `markContext` stores: the 32 characters a side. The
         * prefix begins mid-word, in `taught`, which is the defect. */
        prefix: 'ght the boy to fish and the boy ',
        suffix: ' him. Last one.',
      }),
    )

    expect(seen).toHaveLength(1)
    expect(seen[0]?.term).toBe('loved')
    expect(seen[0]?.context.sentence).toBe(
      'The old man had taught the boy to fish and the boy loved him.',
    )
  })

  /*
   * §C3, the `<br>` case. `He said,<br>and left.` produces a sentinel
   * `Flattened` cannot tell from `</p>`, so the run ends at `He said,` — a
   * fragment with a comma on it, which a model would answer about confidently.
   * The extractor declines and the provider must receive THE FALLBACK, not a
   * non-null incomplete result.
   */
  it('is sent the fallback when a <br> cut the sentence, never the fragment', async () => {
    const fixture = buildFixture(elem('p', {}, [txt('He said,'), elem('br', {}), txt('and left.')]))
    const selection = selectionOf(fixture, 'said', ['He said,', 3], ['He said,', 7], {
      prefix: 'He ',
      suffix: ', and left.',
    })

    const { seen } = await askThrough(selection)

    expect(seen[0]?.context.sentence).toBe(sentenceAround('He ', 'said', ', and left.'))
    expect(seen[0]?.context.sentence).toBe('He said, and left.')
    /* And specifically NOT the fragment the run ends at. */
    expect(seen[0]?.context.sentence).not.toBe('He said,')
  })

  /*
   * §C3 again, across two blocks. The end anchor is in the second paragraph, so
   * nothing in the first one's run can say where the selection stops.
   */
  it('is sent the fallback for a selection spanning two blocks', async () => {
    const fixture = buildFixture(
      elem('div', {}, [
        elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]),
        elem('p', {}, [txt('Delta four. Epsilon five. Zeta six.')]),
      ]),
    )
    const selection: GlossSelection = {
      text: 'two',
      prefix: 'Alpha one. Beta ',
      suffix: '. Gamma three.',
      range: rangeOf(fixture, ['Alpha one. Beta two. Gamma three.', 16], [
        'Delta four. Epsilon five. Zeta six.',
        17,
      ]),
    }

    const { seen } = await askThrough(selection)

    expect(seen[0]?.context.sentence).toBe(sentenceAround(selection.prefix, 'two', selection.suffix))
  })

  /*
   * §B1, AND THIS MUST PASS AT THE WIRING COMMIT — which is why the filters
   * landed before it. Per-character ruby is standard, and `flatten` interleaves
   * the readings: `<ruby>漢<rt>かん</rt>字<rt>じ</rt></ruby>` comes out as
   * `漢かん字`. Sending the raw selection would ask the model to define a word
   * the book does not contain, in a sentence that does not contain it either.
   */
  it('is sent a ruby term and sentence that both read exactly 漢字', async () => {
    const fixture = buildFixture(
      elem('p', {}, [
        txt('前の文です。'),
        elem('ruby', { display: 'ruby' }, [
          txt('漢'),
          elem('rt', { display: 'ruby-text' }, [txt('かん')]),
          txt('字'),
          elem('rt', { display: 'ruby-text' }, [txt('じ')]),
        ]),
        txt('は難しい。次の文です。'),
      ]),
    )
    /* What the selection itself says, readings and all — the string a caller
     * sending `selection.text` would have used. */
    const selection = selectionOf(fixture, '漢かん字', ['漢', 0], ['字', 1], {
      prefix: '前の文です。',
      suffix: 'は難しい。',
    })

    const { seen } = await askThrough(selection)

    expect(seen[0]?.term).toBe('漢字')
    expect(seen[0]?.context.sentence).toBe('漢字は難しい。')
    expect(seen[0]?.context.sentence).toContain(seen[0]?.term ?? '')
    expect(seen[0]?.term).not.toContain('かん')
    expect(seen[0]?.context.sentence).not.toContain('かん')
  })

  /*
   * WI-16.4's own condition. A fixed-layout book takes the fallback until
   * WI-16.5 measures a PDF and a pre-paginated EPUB SEPARATELY — `fixedLayout`
   * covers both and one cannot justify enabling the other. The pair is asserted
   * together, so a flag wired to nothing fails here.
   */
  it('is sent the fallback for a fixed-layout book, and the sentence otherwise', async () => {
    const whole =
      'First one. The old man had taught the boy to fish and the boy loved him. Last one.'
    const fixture = buildFixture(elem('p', {}, [txt(whole)]))
    const selection = selectionOf(fixture, 'loved', [whole, 62], [whole, 67], {
      prefix: 'ght the boy to fish and the boy ',
      suffix: ' him. Last one.',
    })

    const fixed = await askThrough(selection, { fixedLayout: true })
    const reflowable = await askThrough(selection, { fixedLayout: false })

    /* The window, starting mid-`taught` — which is the point: the flag is
     * wired to something a reader could see, not to a value that happens to
     * match. */
    expect(fixed.seen[0]?.context.sentence).toBe(
      'ght the boy to fish and the boy loved him.',
    )
    expect(reflowable.seen[0]?.context.sentence).toBe(
      'The old man had taught the boy to fish and the boy loved him.',
    )
  })
})

describe('whether the sentence path fires', () => {
  /*
   * §F4. Counted, never shown: after this phase some lookups use a real
   * sentence and some fall back, and a build where EVERY lookup falls back
   * looks identical to a working one from the outside.
   *
   * The reason is a closed enum word — never the sentence, the term, or any
   * book text. That is asserted here rather than trusted to `Diagnostics`'
   * redaction, because `outcome` and `gap` are not keys the redactor covers.
   */
  it('records the outcome without recording any of the book', () => {
    const fixture = buildFixture(elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]))
    const whole = 'Alpha one. Beta two. Gamma three.'
    const selection = selectionOf(fixture, 'two', [whole, 16], [whole, 19], {
      prefix: 'Alpha one. Beta ',
      suffix: '. Gamma three.',
    })
    const info = vi.fn()
    const diagnostics = { info } as never

    /* A section that opens mid-sentence: nothing lies before the run, and the
       sentence does not start at its edge either. */
    const opening = 'and so it ended. Delta four.'
    const midSentence = buildFixture(elem('p', {}, [txt(opening)]))

    glossRequest(selection, { diagnostics })
    glossRequest(selection, { diagnostics, fixedLayout: true })
    glossRequest(
      selectionOf(midSentence, 'so', [opening, 4], [opening, 6], { prefix: 'and ', suffix: ' it ended.' }),
      { diagnostics },
    )

    expect(info.mock.calls).toEqual([
      ['gloss.sentence', { outcome: 'used' }],
      ['gloss.sentence', { outcome: 'fallback', gap: 'fixed-layout' }],
      ['gloss.sentence', { outcome: 'fallback', gap: 'run-start' }],
    ])
    const written = JSON.stringify(info.mock.calls)
    expect(written).not.toContain('Beta')
    expect(written).not.toContain('ended')
  })
})

describe('the handler itself', () => {
  /* Nothing to look up. The guard is in the handler rather than at each call
   * site, so a caller cannot forget it. */
  it('does nothing at all with no selection', async () => {
    const { provider, seen } = spyProvider()
    const { result } = renderHook(() => useGloss(provider))

    await act(async () => {
      askGloss(result.current, null, { fixedLayout: false, ...CONTEXT })
    })

    expect(seen).toEqual([])
  })

  /*
   * The FIELD-level mutation, closed by the type rather than by a case: a
   * caller that omitted `fixedLayout` would silently start walking PDFs, where
   * a run is one visual line and the walk can vouch for nothing (§16.5). It is
   * required in `AskGlossOptions`, so that omission does not compile. Asserted
   * here as a fact about the contract, since a compile error leaves no runtime
   * trace for a reader of this file to find.
   */
  it('requires the caller to say whether the book is fixed-layout', () => {
    const options: Parameters<typeof askGloss>[2] = { fixedLayout: false, ...CONTEXT, bookTitle: '' }

    expect(Object.keys(options)).toContain('fixedLayout')
    // @ts-expect-error — omitting it is the mutation this refuses.
    const dropped: Parameters<typeof askGloss>[2] = { ...CONTEXT, bookTitle: '' }
    expect(dropped).toBeDefined()
  })

  it('carries the book title through to the provider', async () => {
    const fixture = buildFixture(elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]))
    const whole = 'Alpha one. Beta two. Gamma three.'
    const { provider, seen } = spyProvider()
    const { result } = renderHook(() => useGloss(provider))

    await act(async () => {
      askGloss(
        result.current,
        selectionOf(fixture, 'two', [whole, 16], [whole, 19], { prefix: '', suffix: '' }),
        { fixedLayout: false, ...CONTEXT },
      )
    })

    expect(seen[0]?.context.bookTitle).toBe('Moby-Dick')
  })

  /*
   * §E6 reaches the counter too. `Diagnostics` carries no no-throw contract —
   * the default writes nothing, but a sink the composition root chose is
   * ordinary code — and the recording call sits outside `sentenceAt`'s own
   * try. A throwing sink therefore took the reader's lookup down with it: no
   * gloss, no fallback, nothing.
   */
  it('still reaches the provider when the diagnostics sink throws', async () => {
    const fixture = buildFixture(elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]))
    const whole = 'Alpha one. Beta two. Gamma three.'
    const exploding = {
      info: () => {
        throw new Error('the sink is broken')
      },
      error: () => {
        throw new Error('the sink is broken')
      },
    } as never

    /* Both branches: the one that goes through `sentenceAt`, and the one where
     * the caller reports the fixed-layout skip itself. */
    const walked = await askThrough(
      selectionOf(fixture, 'two', [whole, 16], [whole, 19], {
        prefix: 'Alpha one. Beta ',
        suffix: '. Gamma three.',
      }),
      { diagnostics: exploding },
    )
    const skipped = await askThrough(
      selectionOf(fixture, 'two', [whole, 16], [whole, 19], {
        prefix: 'Alpha one. Beta ',
        suffix: '. Gamma three.',
      }),
      { diagnostics: exploding, fixedLayout: true },
    )

    expect(walked.seen[0]?.context.sentence).toBe('Beta two.')
    expect(skipped.seen[0]?.context.sentence).toBe('Beta two.')
  })
})

/**
 * ⚠️ **THE PRESS THAT USED TO DO NOTHING.**
 *
 * `ask` began `if (!provider.available) return`, and while Dictionary.app sat
 * behind the gesture that was harmless — the lookup went to the system
 * dictionary and the gloss simply did not contribute. The hand-off is deleted,
 * so a silent return is a dictionary button that does nothing at all on a
 * fresh desktop, with nothing on screen to say why.
 *
 * These cases are what make the difference between the two behaviours
 * observable. Without them the silent return is indistinguishable from the
 * state below in any test that only watches the provider.
 */
describe('with no model installed', () => {
  const nothing: GlossProvider = {
    available: false,
    warm() {},
    /* TRUE, because the case worth pinning is the desktop one: `inference` is
       composed, the Local models pane exists, and only the download is
       missing.
       ⚠️ THIS USED TO SAY "the hook does not read this field — the reader UI
       does". It does now, and that is the fix: the reader UI reads it when the
       BUTTON IS DRAWN and this state is reached when it is PRESSED, so a model
       uninstalled in between offered a download into a runtime that was not
       there. See the `installable` case below. */
    installAt: MODELS,
    async gloss() {
      throw new Error('the hook must not call a provider that says it cannot answer')
    },
  }

  it('says so, rather than returning silently', () => {
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'gam', installAt: MODELS })
  })

  /* NOT `failed`, and the distinction is the reader's not the maintainer's:
     one says something went wrong and the other says something is missing.
     Rendering them the same way would tell a reader on a fresh install that
     Paper is broken. */
  it('is not reported as a failure', () => {
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', CONTEXT)
    })

    expect(result.current.state.kind).not.toBe('failed')
  })

  /* The provider's own contract is that `gloss` THROWS when it cannot answer
     — `NO_GLOSS` says so in capitals — so a hook that called it anyway would
     turn every press into an unhandled rejection. The fake above throws with a
     message naming this, so the failure is legible if it ever regresses. */
  it('does not call a provider that has already said it cannot answer', () => {
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', CONTEXT)
    })

    expect(result.current.state.kind).toBe('unavailable')
  })

  /*
   * ⚠️ **AND IT DOES NOT WALK THE DOCUMENT ON THE WAY**, which is about the
   * §F4 counter rather than about cycles.
   *
   * `glossRequest` records `gloss.sentence` with its outcome, and that counter
   * exists because "a build where every lookup silently falls back looks
   * identical to a working one". The dictionary button now fires on machines
   * with NO model, where it can only produce the install prompt — so walking
   * there would file a sample per press for a lookup that never happened. On a
   * machine with no model that is EVERY sample, and the one instrument that
   * can answer "is the walk working" would be reading pure noise.
   */
  it('files no sentence diagnostic, because no lookup happened', () => {
    const fixture = buildFixture(elem('p', {}, [txt('Alpha one. Beta two. Gamma three.')]))
    const whole = 'Alpha one. Beta two. Gamma three.'
    const info = vi.fn()
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      askGloss(
        result.current,
        selectionOf(fixture, 'two', [whole, 16], [whole, 19], {
          prefix: 'Alpha one. Beta ',
          suffix: '. Gamma three.',
        }),
        { fixedLayout: false, ...CONTEXT, diagnostics: { info } as never },
      )
    })

    expect(info).not.toHaveBeenCalled()
    /* Non-vacuity: the press really did reach the hook, so the silence above
       is "did not walk" rather than "did nothing at all" — which is the
       failure this whole state exists to end. It names the RAW selection,
       because the sentence-spelled term is what the skipped walk produces. */
    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'two', installAt: MODELS })
  })

  /* THE MODEL WENT BETWEEN TWO PRESSES. The first lookup is still generating
     when the reader, who has since uninstalled the model, asks about another
     word: the prompt to install one replaces it, and the first answer — landing
     afterwards from a runtime that is going — must not replace the prompt. */
  it('takes the lookup in flight down with it, so its answer never replaces the prompt', async () => {
    const live = { available: true }
    let signalled: AbortSignal | null = null
    let answer = (_text: string): void => {}
    const provider: GlossProvider = {
      warm() {},
      get available() {
        return live.available
      },
      installAt: MODELS,
      gloss: (_term, _context, signal) => {
        signalled = signal
        return new Promise<Definition>((resolve) => {
          answer = (text) => resolve({ text })
        })
      },
    }
    const { result } = renderHook(() => useGloss(provider))
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })
    expect(result.current.state).toEqual({ kind: 'asking', term: 'gam' })

    live.available = false
    act(() => {
      result.current.ask(() => ({ term: 'wharves', sentence: 'The wharves.' }), 'wharves', CONTEXT)
    })
    expect((signalled as unknown as AbortSignal).aborted, 'the first lookup was left generating').toBe(true)

    await act(async () => {
      answer('A meeting between whaling ships.')
    })
    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'wharves', installAt: MODELS })
  })

  /* And it is dismissable, like every other thing the strip shows. A state the
     reader cannot put away is a state that outstays the question. */
  it('is dismissed like any other', () => {
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', CONTEXT)
    })
    act(() => {
      result.current.dismiss()
    })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })
})

/**
 * ⚠️ **THE OTHER PRESS THAT USED TO DO NOTHING**, and it outlived the fix for
 * its twin above by a whole phase.
 *
 * `lookUpPress` held the term bound and `return`ed on a term it refused: the
 * button was drawn, the press was accepted, and there was no state, no message
 * and no diagnostic. A reader who selected a paragraph could not tell a refusal
 * from a broken feature. The bound now lives in `ask`, where the answer to it
 * can be something the reader reads.
 */
describe('with a passage rather than a term', () => {
  const model: GlossProvider = {
    available: true,
    installAt: MODELS,
    warm() {},
    async gloss() {
      throw new Error('a passage must not reach the provider')
    },
  }

  it('says so, rather than returning silently', () => {
    const { result } = renderHook(() => useGloss(model))

    act(() => {
      result.current.ask(
        () => ({ term: 'x', sentence: 'x' }),
        'a'.repeat(121),
        CONTEXT,
      )
    })

    expect(result.current.state).toEqual({ kind: 'tooLong' })
  })

  /* THE WALK NEVER RUNS. `request` is the thunk that flattens the document —
     the whole reason it is deferred — and a passage that will not be sent must
     not pay for one, nor file a `gloss.sentence` sample for a lookup that did
     not happen (§F4). */
  it('does not build the request it is not going to send', () => {
    const { result } = renderHook(() => useGloss(model))
    const request = vi.fn(() => ({ term: 'x', sentence: 'x' }))

    act(() => {
      result.current.ask(request, 'a'.repeat(121), CONTEXT)
    })

    expect(request).not.toHaveBeenCalled()
  })

  /* AHEAD OF `available`, because it is a fact about what the READER chose and
     is true whether or not a model exists. "Paper needs a language model to
     define <a chapter>" is the wrong sentence twice over. */
  it('is decided before the model is, so the message is about the gesture', () => {
    const nothingInstalled: GlossProvider = {
      available: false,
      installAt: MODELS,
      warm() {},
      async gloss() {
        throw new Error('unreachable')
      },
    }
    const { result } = renderHook(() => useGloss(nothingInstalled))

    act(() => {
      result.current.ask(() => ({ term: 'x', sentence: 'x' }), 'a'.repeat(121), CONTEXT)
    })

    expect(result.current.state.kind).toBe('tooLong')
  })

  /* AN EMPTY SELECTION IS THE ONE THING WITH NOTHING TO SAY, which is why
     `termVerdict` has three answers rather than two: there is no passage to
     refuse and no message to write about one, so the state is left alone
     rather than a report being invented for it. */
  it('leaves the state alone for an empty selection', () => {
    const { result } = renderHook(() => useGloss(model))

    act(() => {
      result.current.ask(() => ({ term: 'x', sentence: 'x' }), '   \n ', CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  /* IT REPLACES AN ANSWER ON SCREEN. A reader looking at a definition who then
     selects a paragraph and presses Look up must not be left reading the
     previous word's gloss as though it answered the new gesture. */
  it('replaces a definition already on screen', async () => {
    const { result } = renderHook(() => useGloss(model))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', CONTEXT)
    })
    act(() => {
      result.current.ask(() => ({ term: 'x', sentence: 'x' }), 'a'.repeat(121), CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'tooLong' })
  })

  /* AND A DEFINITION STILL ON ITS WAY. The reader has asked a second question,
     so the first is abandoned — told to stop, and its answer, when it lands,
     is about a word they have moved on from and must not replace the refusal
     of what they asked since. */
  it('takes the lookup in flight down, so its answer never replaces the refusal', async () => {
    let signalled: AbortSignal | null = null
    let answer = (_text: string): void => {}
    const slow: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      gloss: (_term, _context, signal) => {
        signalled = signal
        return new Promise<Definition>((resolve) => {
          answer = (text) => resolve({ text })
        })
      },
    }
    const { result } = renderHook(() => useGloss(slow))
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    act(() => {
      result.current.ask(() => ({ term: 'x', sentence: 'x' }), 'a'.repeat(121), CONTEXT)
    })
    expect((signalled as unknown as AbortSignal).aborted, 'the first lookup was left generating').toBe(true)

    await act(async () => {
      answer('A meeting between whaling ships.')
    })
    expect(result.current.state).toEqual({ kind: 'tooLong' })
  })
})

/**
 * ⚠️ **`installable` IS READ AT THE PRESS, AND IT USED TO BE READ ONLY AT THE
 * DRAW.**
 *
 * `decideLookUp` asks the provider when the button is created; this state is
 * reached when the button is pressed. A model uninstalled between the two
 * arrives here from a button drawn as `gloss`, and `Reader` passed the strip
 * `onInstall` unconditionally on the argument that it could not — so the strip
 * offered a 2.5 GB download into a runtime that is not there, which is the
 * WI-20.21 failure `GlossProvider.installable` exists to prevent.
 */
describe('what an unavailable press records about installing', () => {
  function providerWith(installAt: string | null): GlossProvider {
    return {
      available: false,
      installAt,
      warm() {},
      async gloss() {
        throw new Error('unreachable')
      },
    }
  }

  it.each([MODELS, null])('carries the provider’s answer of %s', (installAt) => {
    const { result } = renderHook(() => useGloss(providerWith(installAt)))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'gam', installAt })
  })

  /* THE WINDOW ITSELF: the button was drawn while a model was installed, and
     the press lands after it is gone and the runtime with it. Read at the draw,
     this would have said `true`. */
  it('reads it at the press, not at the render that drew the button', () => {
    const live: { available: boolean; installAt: string | null } = { available: true, installAt: MODELS }
    const provider: GlossProvider = {
      warm() {},
      get available() {
        return live.available
      },
      get installAt() {
        return live.installAt
      },
      async gloss() {
        throw new Error('unreachable')
      },
    }
    const { result } = renderHook(() => useGloss(provider))

    live.available = false
    live.installAt = null
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'gam', installAt: null })
  })
})

/**
 * ⚠️ **THE PROMPT GOES AWAY WHEN ITS REASON DOES — AND NOTHING ELSE DOES.**
 *
 * `unavailable` offers the download. A reader who took the offer came back to a
 * prompt still telling them to take it, so the arrival of a model clears that
 * one state. Only that one: a `ready` gloss is still the answer to the word they
 * asked about, and a `failed` one is not un-failed by a model appearing.
 */
describe('when a model arrives', () => {
  function liveProvider(gloss: GlossProvider['gloss']): { provider: GlossProvider; live: { available: boolean } } {
    const live = { available: false }
    return {
      live,
      provider: {
        get available() {
          return live.available
        },
        installAt: MODELS,
        warm() {},
        gloss,
      },
    }
  }

  it('takes down the prompt to install one', () => {
    const { provider, live } = liveProvider(async () => ({ text: 'unreachable' }))
    const { result, rerender } = renderHook(() => useGloss(provider))
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })
    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'gam', installAt: MODELS })

    live.available = true
    rerender()

    expect(result.current.state, 'the prompt outlived the install it asked for').toEqual({ kind: 'idle' })
  })

  const settled: readonly (readonly [string, GlossProvider['gloss'], GlossState])[] = [
    [
      'a definition on screen',
      async () => ({ text: 'A meeting between whaling ships.' }),
      { kind: 'ready', term: 'gam', text: 'A meeting between whaling ships.' },
    ],
    [
      'a failure on screen',
      async () => {
        throw new Error('The runtime stopped')
      },
      { kind: 'failed', term: 'gam', reason: 'The runtime stopped' },
    ],
  ]

  it.each(settled)('leaves %s alone', async (_case, gloss, shown) => {
    const { provider, live } = liveProvider(gloss)
    live.available = true
    const { result, rerender } = renderHook(() => useGloss(provider))
    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })
    expect(result.current.state).toEqual(shown)

    /* The model goes, and comes back: the arrival the prompt waits for. */
    live.available = false
    rerender()
    live.available = true
    rerender()

    expect(result.current.state).toEqual(shown)
  })
})

/**
 * ⚠️ **A GLOSS DOES NOT OUTLIVE THE PASSAGE IT DESCRIBES**, and it used to.
 *
 * `dismiss` had exactly one caller — the strip's own × — so an amber definition
 * survived a page turn, a chapter change, opening another book and a trip to
 * the library. Every surface beside it is taken down on those events with the
 * reasoning written out; this one, the one drawing MACHINE-WRITTEN text in the
 * reader's own page, had no teardown at all.
 *
 * Driven here rather than in `Reader`, which takes sixteen props and renders
 * foliate — the same argument that put `lookUpPress` and `askGloss` in files of
 * their own.
 */
/*
 * ⚠️ **THE FIRST LOOKUP OF A SESSION WAS THE SLOW ONE**, because nothing bound
 * the runtime until a gloss was asked for: the first ask paid for a process, an
 * accelerator probe and a model load with the reader watching an empty popover,
 * and every later one was quick. One gesture, two very different waits.
 *
 * A selection is the earliest honest signal that a lookup MIGHT be coming, and
 * it costs nothing for a reader who never selects. See `GlossProvider.warm`.
 */
describe('getting the runtime ready before anything is asked of it', () => {
  it('asks the provider to get ready as soon as there is a selection to look up', () => {
    const { provider, warmed } = spyProvider()

    const initial: { at: string | null } = { at: null }
    const { rerender } = renderHook(({ at }: { at: string | null }) => useGloss(provider, at), { initialProps: initial })
    /* Nothing selected is nothing to get ready for. */
    expect(warmed()).toBe(0)

    rerender({ at: 'book-1|3|ch3.xhtml' })

    expect(warmed()).toBe(1)
  })

  /* Warming a provider that cannot define anything would start a daemon to
     answer a question it has no model for — and `available` is the field that
     knows. */
  it('gets nothing ready when nothing could define anything', () => {
    let warmed = 0
    const none: GlossProvider = {
      available: false,
      installAt: MODELS,
      warm() {
        warmed += 1
      },
      async gloss() {
        throw new Error('nothing defines here')
      },
    }

    renderHook(() => useGloss(none, 'book-1|3|ch3.xhtml'))

    expect(warmed).toBe(0)
  })
})

describe('when the passage stops being shown', () => {
  const model: GlossProvider = {
    available: true,
    installAt: MODELS,
    /* An anchor is what asks for one — see the warm case below. */
    warm() {},
    async gloss() {
      return { text: 'a meeting between whaling ships' }
    },
  }

  it('takes the definition down when the anchor moves', async () => {
    const { result, rerender } = renderHook(({ at }: { at: string | null }) => useGloss(model, at), {
      initialProps: { at: 'book-1|3|ch3.xhtml' },
    })
    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })
    expect(result.current.state.kind).toBe('ready')

    rerender({ at: 'book-1|4|ch4.xhtml' })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  /* `null` IS "NOWHERE", which is what `Reader` passes while `inert` — the
     reader is under the library and the book is not on screen. `inert` already
     clears the selection for this reason and the gloss was what it did not
     reach. */
  it('takes it down when there is no anchor at all', async () => {
    const { result, rerender } = renderHook(({ at }: { at: string | null }) => useGloss(model, at), {
      initialProps: { at: 'book-1|3|ch3.xhtml' as string | null },
    })
    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    rerender({ at: null })

    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  /* AND THE REQUEST IN FLIGHT GOES WITH IT. A gloss asked for just before a
     page turn used to land on the next page and render; worse, the daemon kept
     generating for a reader who had gone. `dismiss` aborts, which is what
     `glossProvider` turns into a cancel. */
  it('aborts a lookup still in flight', () => {
    let signalled: AbortSignal | null = null
    const slow: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      gloss(_term, _context, signal) {
        signalled = signal
        return new Promise<Definition>(() => {})
      },
    }
    const { result, rerender } = renderHook(({ at }: { at: string | null }) => useGloss(slow, at), {
      initialProps: { at: 'book-1|3|ch3.xhtml' },
    })
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })
    expect(result.current.state.kind).toBe('asking')

    rerender({ at: 'book-2|0|ch1.xhtml' })

    expect(signalled).not.toBeNull()
    expect((signalled as unknown as AbortSignal).aborted).toBe(true)
  })

  /* NON-VACUITY. A hook that dismissed on every render would pass all three
     above and destroy the feature — the gloss would never survive its own
     arrival. An unchanged anchor must leave it standing. */
  it('leaves it standing while the anchor holds', async () => {
    const { result, rerender } = renderHook(({ at }: { at: string | null }) => useGloss(model, at), {
      initialProps: { at: 'book-1|3|ch3.xhtml' },
    })
    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    rerender({ at: 'book-1|3|ch3.xhtml' })

    expect(result.current.state).toMatchObject({ kind: 'ready', term: 'gam' })
  })

  /* AND WHEN THE READER THAT ASKED IS GONE ALTOGETHER. A gloss outliving its
     hook is a request nobody will read — on a loaded machine, a model still
     generating for a surface that no longer exists. */
  it('aborts a lookup still in flight when the hook unmounts', () => {
    let signalled: AbortSignal | null = null
    const slow: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      gloss(_term, _context, signal) {
        signalled = signal
        return new Promise<Definition>(() => {})
      },
    }
    const { result, unmount } = renderHook(() => useGloss(slow))
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })
    expect((signalled as unknown as AbortSignal).aborted).toBe(false)

    unmount()

    expect((signalled as unknown as AbortSignal).aborted, 'the model was left generating for nobody').toBe(true)
  })
})

/**
 * ONE LOOKUP AT A TIME, AND THE ONE ON SCREEN IS THE NEWEST — whatever the ones
 * before it do when they finally settle. A definition, a failure or a refusal
 * for a word the reader has moved on from is worse than nothing, because it
 * reads as the answer to what they asked since.
 */
describe('a lookup the reader has moved on from', () => {
  /** A provider whose every call waits for the test, holding the signal it was given. */
  function heldProvider(): {
    provider: GlossProvider
    calls: { signal: AbortSignal; answer: (text: string) => void }[]
  } {
    const calls: { signal: AbortSignal; answer: (text: string) => void }[] = []
    return {
      calls,
      provider: {
        available: true,
        installAt: MODELS,
        warm() {},
        gloss: (_term, _context, signal) =>
          new Promise<Definition>((resolve) => {
            calls.push({ signal, answer: (text) => resolve({ text }) })
          }),
      },
    }
  }

  it('is idle from the first render, before any effect has run', () => {
    const { provider } = heldProvider()
    const drawn: GlossState[] = []
    renderHook(() => {
      const gloss = useGloss(provider)
      drawn.push(gloss.state)
      return gloss
    })

    expect(drawn[0], 'the first frame drew a state that is none of the five').toEqual({ kind: 'idle' })
  })

  /* A PROVIDER REJECTS WHEN IT IS ABORTED — `glossProvider` throws an
     `AbortError` for exactly this — so the refusal of an abandoned lookup
     arrives as a failure, after the reader has already put it away. */
  it('says nothing when a dismissed lookup rejects for being aborted', async () => {
    const aborting: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      gloss: (_term, _context, signal) =>
        new Promise<Definition>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    }
    const { result } = renderHook(() => useGloss(aborting))
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    await act(async () => {
      result.current.dismiss()
    })

    expect(result.current.state, 'the abort the reader caused was reported as a failed lookup').toEqual({
      kind: 'idle',
    })
  })

  /* THE OLDER LOOKUP SETTLING LATE MUST NOT LET GO OF THE NEWER ONE. Had it
     cleared the hook's hold on "the request in flight" as it went, dismissing
     would abort nothing — and the newer answer would land on a strip the reader
     had closed. */
  it('keeps hold of the newer lookup when the one it replaced settles late', async () => {
    const { provider, calls } = heldProvider()
    const { result } = renderHook(() => useGloss(provider))
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })
    act(() => {
      result.current.ask(() => ({ term: 'wharves', sentence: 'The wharves.' }), 'wharves', CONTEXT)
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.signal.aborted).toBe(true)

    await act(async () => {
      calls[0]?.answer('A meeting between whaling ships.')
    })
    expect(result.current.state).toEqual({ kind: 'asking', term: 'wharves' })

    act(() => {
      result.current.dismiss()
    })
    expect(calls[1]?.signal.aborted, 'dismissing no longer reached the lookup still generating').toBe(true)

    await act(async () => {
      calls[1]?.answer('Where ships tie up.')
    })
    expect(result.current.state, 'an answer landed on a strip the reader had closed').toEqual({ kind: 'idle' })
  })

  /* AN ABORT IS "THE READER WALKED AWAY FROM THIS REQUEST", which is not true of
     one that has already answered — `glossProvider` turns an abort into a cancel
     sent to the runtime. Put away, or replaced by the next question, a finished
     lookup is left alone. */
  it('does not abort a lookup that has already answered', async () => {
    const signals: AbortSignal[] = []
    const answering: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      async gloss(_term, _context, signal) {
        signals.push(signal)
        return { text: 'A meeting between whaling ships.' }
      },
    }
    const { result } = renderHook(() => useGloss(answering))
    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })
    expect(result.current.state).toEqual({ kind: 'ready', term: 'gam', text: 'A meeting between whaling ships.' })

    await act(async () => {
      result.current.ask(() => ({ term: 'wharves', sentence: 'The wharves.' }), 'wharves', CONTEXT)
    })
    act(() => {
      result.current.dismiss()
    })

    expect(signals.map((signal) => signal.aborted), 'an answered lookup was cancelled after the fact').toEqual([
      false,
      false,
    ])
  })

  /* THE PROVIDER IS THE ONE OF THE LAST RENDER. A press asks whatever the host
     composes now, not what it composed when the reader first opened the book. */
  it('asks the provider it was last rendered with', async () => {
    const first: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      async gloss() {
        return { text: 'from the first render' }
      },
    }
    const latest: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      async gloss() {
        return { text: 'from the latest render' }
      },
    }
    const { result, rerender } = renderHook(({ provider }: { provider: GlossProvider }) => useGloss(provider), {
      initialProps: { provider: first },
    })
    rerender({ provider: latest })

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'ready', term: 'gam', text: 'from the latest render' })
  })
})

/**
 * ⚠️ **THE FALLBACK'S OWN SEGMENTATION, WHICH USED TO BE A SECOND POLICY AND
 * WAS MEASURED WRONG TWICE.**
 *
 * `/(?<=[.!?。！？])\s+/` is a NO-OP on Chinese — the lookbehind lists the CJK
 * terminators but the pattern still demands a space after them, and Chinese
 * does not write one — and an abbreviation before the term erased the entire
 * prefix. Phase 16 measured both and deliberately left them, because its own
 * claim was that the fallback was unchanged. It goes through `sentenceOf` now,
 * with §C1's gate off: one policy, two tolerances.
 *
 * These cases are the exact strings phase 16 recorded as broken.
 */
describe('the fallback sentence', () => {
  /* THE ONE THAT MATTERED MOST. A fixed-layout book never reaches the walk
     (WI-16.5), so for a Chinese PDF this was not an edge case — it was the
     whole feature, sending the raw 32-character window every time. */
  it('splits Chinese, which the regex could not', () => {
    expect(sentenceAround('他说。然后走了。今天的', '天气', '很好。明天呢？')).toBe('今天的天气很好。')
  })

  /* `'He met Mr. '.split(…).pop()` was `''`, so the model was told the term
     began the sentence. `sentenceOf`'s bounded merge keeps the title with the
     name after it. */
  it('keeps the prefix across an abbreviation, which the regex erased', () => {
    expect(sentenceAround('He met Mr. ', 'Smith', ' at noon. Then left.')).toBe(
      'He met Mr. Smith at noon.',
    )
  })

  it('takes the sentence the term sits in out of an ordinary window', () => {
    expect(sentenceAround('First one. The old man ', 'loved', ' him. Last one.')).toBe(
      'The old man loved him.',
    )
  })

  /* NO WORSE THAN THE WINDOW IT WAS GIVEN, and this is the defect the WALK was
     built to fix rather than one this can. `markContext` stores 32 characters a
     side for RE-ANCHORING, so the window starts mid-word — `"ght the boy"`, cut
     out of `taught` — and no segmenter can put back a head that was never
     there. The head is kept exactly as the regex kept it. */
  it('cannot recover a window that was already cut mid-word', () => {
    expect(sentenceAround('ght the boy to fish and the boy ', 'loved', ' him. Last one.')).toBe(
      'ght the boy to fish and the boy loved him.',
    )
  })

  /* And with genuinely no boundary anywhere, the whole window — which is what
     the regex produced on every input it failed on. */
  it('returns the whole window when it holds no boundary at all', () => {
    expect(sentenceAround('the boy to fish and the boy ', 'loved', ' him and the sea')).toBe(
      'the boy to fish and the boy loved him and the sea',
    )
  })

  /* A selection with no context either side is its own sentence — better than
     an empty string, which would ask the model to define a word in a vacuum. */
  it('is its own sentence with no context either side', () => {
    expect(sentenceAround('', 'gam', '')).toBe('gam')
    expect(sentenceAround('  ', '  ', '  ')).toBe('  ')
  })

  /* WHAT `sentenceOf` REFUSES, WITH A WINDOW AROUND IT, IS THAT WINDOW —
     squeezed as the regex left it: trimmed, every run of whitespace one space.
     A term that squeezes to nothing is one such refusal; handing back the bare
     term there would send the model a line break to define. */
  it('is the squeezed window when the term squeezes to nothing', () => {
    expect(sentenceAround('He said  ', ' \n ', '  and left. ')).toBe('He said and left.')
  })

  /* §C1 IS OFF HERE AND ONLY HERE. The window is cut mid-sentence by
     construction, so `sentenceAt`'s rule — a boundary at the run's edge is not
     evidence of a sentence ending — would decline every single call and leave
     this with nothing to answer. Non-vacuity for `requireComplete`: with the
     gate on, this input has no interior boundary before the term and would be
     refused. */
  it('answers where the walk would decline', () => {
    expect(sentenceAround('old man ', 'loved', ' him. Last')).toBe('old man loved him.')
  })

  /* THE LOCALE IS A NICETY, NOT A REQUIREMENT, and that is measured: ICU
     segments `。` the same under every locale tag, so a Chinese PDF stamped
     `lang="en"` by `makePdf` still splits correctly. What the locale changes is
     the Latin abbreviation merge, which is gated by script. */
  it('splits Chinese under an English locale, which is what a PDF declares', () => {
    expect(
      sentenceAround('他说。然后走了。今天的', '天气', '很好。明天呢？', { locale: 'en' }),
    ).toBe('今天的天气很好。')
  })
})

/**
 * WHAT ARRIVES IS HANDED ON, ONCE, TO THE ASK THAT ASKED FOR IT (WI-17.2), and
 * in the language that ask resolved (WI-17.5).
 */
describe('an answered lookup', () => {
  const answering = (text = 'A meeting between whaling ships.'): GlossProvider => ({
    available: true,
    installAt: MODELS,
    warm() {},
    async gloss() {
      return { text }
    },
  })

  it('is handed to the ask’s own recorder with what was asked', async () => {
    const onAnswer = vi.fn()
    const { result } = renderHook(() => useGloss(answering()))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam at sea.' }), 'gam', { ...CONTEXT, onAnswer })
    })

    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith({
      term: 'gam',
      sentence: 'A gam at sea.',
      text: 'A meeting between whaling ships.',
      answerIn: [ENGLISH],
    })
  })

  it('is not handed on when it failed', async () => {
    const onAnswer = vi.fn()
    const failing: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      async gloss() {
        throw new Error('The runtime stopped')
      },
    }
    const { result } = renderHook(() => useGloss(failing))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', { ...CONTEXT, onAnswer })
    })

    expect(result.current.state.kind).toBe('failed')
    expect(onAnswer).not.toHaveBeenCalled()
  })

  /* A REJECTION THAT IS NOT AN `Error` CARRIES NO MESSAGE, and the view's own
     first line already says Paper could not define the word — so the reason
     says only that there is nothing more to say, never an empty line. */
  it('fails with no reason given when the rejection carries no message', async () => {
    const bare: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      gloss: () => Promise.reject({ kind: 'stopped' }),
    }
    const { result } = renderHook(() => useGloss(bare))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'failed', term: 'gam', reason: 'No reason was given.' })
  })

  /* A lookup the reader walked away from is not a lookup they made — the
     answer that lands afterwards must not be filed. */
  it('is not handed on when the reader dismissed it before it arrived', async () => {
    const onAnswer = vi.fn()
    let answer = (_text: string): void => {}
    const slow: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      gloss: () =>
        new Promise<Definition>((resolve) => {
          answer = (text) => resolve({ text })
        }),
    }
    const { result } = renderHook(() => useGloss(slow))
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', { ...CONTEXT, onAnswer })
    })
    act(() => {
      result.current.dismiss()
    })

    await act(async () => {
      answer('late')
    })

    expect(onAnswer).not.toHaveBeenCalled()
    expect(result.current.state).toEqual({ kind: 'idle' })
  })

  /* THE DEFINITION IS ON SCREEN WHATEVER THE HISTORY DOES. A recorder that
     throws must not turn an answer into "Paper couldn't define". */
  it('stays on screen when recording it throws, and says the recording failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const full = new Error('the history is full')
    const { result } = renderHook(() => useGloss(answering('Guarded.')))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', {
        ...CONTEXT,
        onAnswer: () => {
          throw full
        },
      })
    })

    expect(result.current.state).toEqual({ kind: 'ready', term: 'gam', text: 'Guarded.' })
    expect(error).toHaveBeenCalledWith('Paper: a lookup was answered and could not be recorded', full)
    error.mockRestore()
  })

  /* NO RECORDER IS NOT A FAILED RECORDING: an ask that files nothing — a host
     with no history — says nothing about filing. */
  it('reports nothing about recording for an ask with no recorder', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useGloss(answering('Unfiled.')))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'ready', term: 'gam', text: 'Unfiled.' })
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  /* WI-17.5: the language is resolved from the PASSAGE's locale, at the press,
     and what the provider is told is what was resolved. */
  it('asks in the language resolved from the passage’s own locale', async () => {
    const seen: GlossContext[] = []
    const provider: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      async gloss(_term, context) {
        seen.push(context)
        return { text: 'x' }
      },
    }
    const chinese = { tag: 'zh-Hans', name: 'Simplified Chinese', label: '简体中文' } as const
    const answerIn = vi.fn((locale: string | undefined) => (locale === 'zh-CN' ? ([chinese] as const) : ([ENGLISH] as const)))
    const { result } = renderHook(() => useGloss(provider))

    await act(async () => {
      result.current.ask(() => ({ term: '守口如瓶', sentence: '他守口如瓶。', locale: 'zh-CN' }), '守口如瓶', {
        ...CONTEXT,
        answerIn,
      })
    })

    expect(answerIn).toHaveBeenCalledWith('zh-CN')
    expect(seen[0]?.answerIn).toEqual([chinese])
  })

  /* And NOT resolved for a press that never reaches a model, for the reason the
     request is a thunk. */
  it('resolves no language for a press with nothing installed', () => {
    const answerIn = vi.fn(() => [ENGLISH] as const)
    const nothing: GlossProvider = {
      available: false,
      installAt: MODELS,
      warm() {},
      async gloss() {
        throw new Error('unreachable')
      },
    }
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', { ...CONTEXT, answerIn })
    })

    expect(answerIn).not.toHaveBeenCalled()
  })
})

/**
 * ⚠️ **A THROW BEFORE THERE IS A PROMISE IS A FAILED LOOKUP TOO**, and it was
 * not — found by the 2026-09-13 audit. Building the request, resolving its
 * language and calling the provider all ran outside the promise's `catch`: a
 * request that could not be built threw out of `ask` with the previous lookup
 * still running, and a provider that threw where it should have rejected left
 * the reader looking at `asking` for good. A recorder written `async` — which
 * its type allowed — rejected past a guard that caught only a throw.
 */
describe('a lookup that throws instead of rejecting', () => {
  const answering: GlossProvider = {
    available: true,
    installAt: MODELS,
    warm() {},
    async gloss() {
      return { text: 'Guarded.' }
    },
  }

  it('fails, and takes the lookup before it down, when its request cannot be built', async () => {
    let signalled: AbortSignal | null = null
    const slow: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      gloss(_term, _context, signal) {
        signalled = signal
        return new Promise<Definition>(() => {})
      },
    }
    const { result } = renderHook(() => useGloss(slow))
    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', CONTEXT)
    })

    await act(async () => {
      result.current.ask(
        () => {
          throw new Error('the page was torn down')
        },
        'wharves',
        CONTEXT,
      )
    })

    expect((signalled as unknown as AbortSignal).aborted).toBe(true)
    expect(result.current.state).toEqual({ kind: 'failed', term: 'wharves', reason: 'the page was torn down' })
  })

  /* UNDER THE TERM THE REQUEST SPELLED, once there is one — the selection
     spells it `Gam` here, and the sentence `gam`. */
  it('fails under the term it was asking about when its language cannot be resolved', async () => {
    const { result } = renderHook(() => useGloss(answering))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'Gam', {
        ...CONTEXT,
        answerIn: () => {
          throw new Error('no language')
        },
      })
    })

    expect(result.current.state).toEqual({ kind: 'failed', term: 'gam', reason: 'no language' })
  })

  it('fails rather than asking for good when the provider throws where it should reject', async () => {
    const throwing: GlossProvider = {
      available: true,
      installAt: MODELS,
      warm() {},
      gloss() {
        throw new Error('the runtime is gone')
      },
    }
    const { result } = renderHook(() => useGloss(throwing))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'Gam', CONTEXT)
    })

    expect(result.current.state).toEqual({ kind: 'failed', term: 'gam', reason: 'the runtime is gone' })
  })

  it('stays on screen, and says the recording failed, when an async recorder rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const full = new Error('the history is full')
    const { result } = renderHook(() => useGloss(answering))

    await act(async () => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam.' }), 'gam', {
        ...CONTEXT,
        onAnswer: async () => {
          throw full
        },
      })
    })

    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('Paper: a lookup was answered and could not be recorded', full))
    expect(result.current.state).toEqual({ kind: 'ready', term: 'gam', text: 'Guarded.' })
    error.mockRestore()
  })
})

describe('the request’s locale', () => {
  it('is carried on both routes — the walk and the fixed-layout fallback', () => {
    const whole = 'Alpha one. Beta two. Gamma three.'
    const fixture = buildFixture(elem('p', {}, [txt(whole)]))
    const selection = selectionOf(fixture, 'two', [whole, 16], [whole, 19], {
      prefix: 'Alpha one. Beta ',
      suffix: '. Gamma three.',
    })

    expect(Object.keys(glossRequest(selection))).toContain('locale')
    expect(Object.keys(glossRequest(selection, { fixedLayout: true }))).toContain('locale')
  })

  /* AND THE FALLBACK SEGMENTS IN IT. A passage declared Chinese does not get the
     Latin abbreviation merge, so its sentence breaks after "Mr." — where the
     host's own locale would have merged it back into one. */
  it('segments the fixed-layout fallback in the passage’s own language', () => {
    const whole = 'Alpha one. He met Mr. Smith today. Beta two.'
    const fixture = buildFixture(elem('p', { attributes: { lang: 'zh' } }, [txt(whole)]))
    const selection = selectionOf(fixture, 'Smith', [whole, 22], [whole, 27], {
      prefix: 'Alpha one. He met Mr. ',
      suffix: ' today. Beta two.',
    })

    const request = glossRequest(selection, { fixedLayout: true })

    expect(request.locale).toBe('zh')
    expect(request.sentence).toBe('Smith today.')
  })
})

describe('what the lookup path costs', () => {
  /*
   * §E3. The walk is on the GESTURE and nowhere else. `publish()` runs on every
   * `selectionchange`, so a second flatten there would be a walk of the
   * document per pointer move while a reader drags a selection.
   *
   * Asserted structurally, because the cheap version — "it is only called from
   * the Look up handler" — is a claim about a file and can be checked as one.
   * A timing assertion here would be flaky and would prove less.
   */
  it('never reaches the selection publish path', () => {
    /* Resolved from the repository root rather than from `import.meta.url`:
     * this file opts into jsdom for the hook, and there `import.meta.url` is an
     * http URL that `fileURLToPath` refuses. `readFileSync` throws if the path
     * is wrong, so a moved file fails loudly instead of scanning nothing. */
    const session = readFileSync(resolve('src/kernel/ui/reader/session.ts'), 'utf8')

    expect(session).not.toMatch(/sentenceAt|glossRequest|askGloss/)
    /* Non-vacuity: the session really is the module that publishes selections,
     * so its silence above means the walk is absent rather than that the file
     * moved. */
    expect(session).toContain('onSelection')
    /* A source assertion, and a weak one — an audit pointed out that a
     * differently named helper called from `publish()` would survive the scan
     * above. The honest instrument is a dependency-cruiser `reachable` rule
     * over the whole call graph, which is a change to the boundary system rather
     * than to this phase. Recorded under "What the audit rounds found" in
     * `dev-docs/plans/phase-16-the-sentence.md` rather than implied away.
     *
     * ⚠️ IT USED TO CARRY MORE WEIGHT THAN THIS. The scan was also the only
     * thing standing behind `Reader`'s lookup DECISION — whether a control is
     * drawn, whether the term is worth sending, what to run. Whether a control
     * is drawn moved to `lookUpPress` in `ui/lookUp.ts`, where `lookUp.test.ts`
     * RUNS it including the case a scan could never see: an action compared
     * against a value it cannot hold. Whether the term is worth sending moved
     * HERE, to `ask` — see "with a passage rather than a term" — because the
     * answer to a refusal is a state, and a guard that only `return`ed was the
     * silence this whole file exists to keep out.
     *
     * ⚠️ AND THE LAST OF IT — THAT THE GESTURE STILL CALLS THE HANDLER — IS RUN
     * NOW TOO, SO ITS SCAN IS GONE. It searched the Look up hook's source for
     * `askGloss(gloss, selection`, and failed on 2026-09-13 when the hook began
     * passing `{ ask }` so that its press stops changing on every render: a
     * rename no reader can see, reported as a broken wiring. `useLookUp.test.ts`
     * presses and watches the provider receive the walk's sentence, which a
     * deleted call fails and a renamed argument does not. What this case pins
     * is the publish path's half alone. */
  })
})
