// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlossContext, GlossProvider } from '../../core/gloss'
import { buildFixture, elem, txt, type Fixture } from '../reader/wordSnap/domFake.testkit'
import { askGloss, glossRequest, sentenceAround, useGloss, type GlossSelection } from './useGloss'

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
} {
  const seen: { term: string; context: GlossContext }[] = []
  return {
    seen,
    provider: {
      available: true,
      installable: true,
      async gloss(term, context) {
        seen.push({ term, context })
        return 'a definition'
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
  /* Through `askGloss`, the whole handler `Reader` calls — not through
   * `glossRequest` on its own. Driving the decision function directly left the
   * step that turns a request into a provider call untested, which an audit
   * pointed out is most of what the wiring IS. */
  await act(async () => {
    askGloss(result.current, selection, {
      fixedLayout: false,
      bookTitle: 'Moby-Dick',
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

    glossRequest(selection, { diagnostics })
    glossRequest(selection, { diagnostics, fixedLayout: true })
    glossRequest(
      selectionOf(fixture, 'Alpha', [whole, 0], [whole, 5], { prefix: '', suffix: ' one.' }),
      { diagnostics },
    )

    expect(info.mock.calls).toEqual([
      ['gloss.sentence', { outcome: 'used' }],
      ['gloss.sentence', { outcome: 'fallback', gap: 'fixed-layout' }],
      ['gloss.sentence', { outcome: 'fallback', gap: 'run-start' }],
    ])
    const written = JSON.stringify(info.mock.calls)
    expect(written).not.toContain('Beta')
    expect(written).not.toContain('Alpha')
  })
})

describe('the handler itself', () => {
  /* Nothing to look up. The guard is in the handler rather than at each call
   * site, so a caller cannot forget it. */
  it('does nothing at all with no selection', async () => {
    const { provider, seen } = spyProvider()
    const { result } = renderHook(() => useGloss(provider))

    await act(async () => {
      askGloss(result.current, null, { fixedLayout: false, bookTitle: 'Moby-Dick' })
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
    const options: Parameters<typeof askGloss>[2] = { fixedLayout: false, bookTitle: '' }

    expect(Object.keys(options)).toContain('fixedLayout')
    // @ts-expect-error — omitting it is the mutation this refuses.
    const dropped: Parameters<typeof askGloss>[2] = { bookTitle: '' }
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
        { fixedLayout: false, bookTitle: 'Moby-Dick' },
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
    /* TRUE, because the case worth pinning is the desktop one: `inference` is
       composed, the Local models pane exists, and only the download is
       missing. The hook does not read this field — the reader UI does — and
       that is itself worth being explicit about. */
    installable: true,
    async gloss() {
      throw new Error('the hook must not call a provider that says it cannot answer')
    },
  }

  it('says so, rather than returning silently', () => {
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', 'Moby-Dick')
    })

    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'gam' })
  })

  /* NOT `failed`, and the distinction is the reader's not the maintainer's:
     one says something went wrong and the other says something is missing.
     Rendering them the same way would tell a reader on a fresh install that
     Paper is broken. */
  it('is not reported as a failure', () => {
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', 'Moby-Dick')
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
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', 'Moby-Dick')
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
        { fixedLayout: false, bookTitle: 'Moby-Dick', diagnostics: { info } as never },
      )
    })

    expect(info).not.toHaveBeenCalled()
    /* Non-vacuity: the press really did reach the hook, so the silence above
       is "did not walk" rather than "did nothing at all" — which is the
       failure this whole state exists to end. It names the RAW selection,
       because the sentence-spelled term is what the skipped walk produces. */
    expect(result.current.state).toEqual({ kind: 'unavailable', term: 'two' })
  })

  /* And it is dismissable, like every other thing the strip shows. A state the
     reader cannot put away is a state that outstays the question. */
  it('is dismissed like any other', () => {
    const { result } = renderHook(() => useGloss(nothing))

    act(() => {
      result.current.ask(() => ({ term: 'gam', sentence: 'A gam is a meeting.' }), 'gam', 'Moby-Dick')
    })
    act(() => {
      result.current.dismiss()
    })

    expect(result.current.state).toEqual({ kind: 'idle' })
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
     * http URL that `fileURLToPath` refuses. `readFileSync` throws if either
     * path is wrong, so a moved file fails loudly instead of scanning nothing. */
    const session = readFileSync(resolve('src/kernel/ui/reader/session.ts'), 'utf8')
    const reader = readFileSync(resolve('src/kernel/ui/screens/Reader.tsx'), 'utf8')

    expect(session).not.toMatch(/sentenceAt|glossRequest|askGloss/)
    /* Non-vacuity: the session really is the module that publishes selections,
     * so its silence above means the walk is absent rather than that the file
     * moved. */
    expect(session).toContain('onSelection')
    /* And the gesture really does reach it. A source assertion, and a weak one
     * — an audit pointed out that a differently named helper called from
     * `publish()` would survive the scan above. The honest instrument is a
     * dependency-cruiser `reachable` rule over the whole call graph, which is a
     * change to the boundary system rather than to this phase. Recorded under
     * "What the audit rounds found" in `dev-docs/plans/phase-16-the-sentence.md`
     * rather than implied away. */
    expect(reader).toContain('askGloss(gloss, selection')
  })
})
