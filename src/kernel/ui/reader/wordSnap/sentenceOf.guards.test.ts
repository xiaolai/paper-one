import { describe, expect, it, vi } from 'vitest'
import { MAX_RUN_CHARS, sentenceOf } from './sentenceOf'

/**
 * The two guards an audit found missing, and the option that made one of them
 * matter.
 *
 * `sentenceCorpus.test.ts` covers the SEGMENTATION against a corpus of real
 * sentences. These are the edges around it: what the abbreviation merge may not
 * cross, and what happens when a caller's offsets are wrong.
 */

/** `raw` with the term marked by `|term|`, so the offsets cannot drift. */
function around(marked: string) {
  const start = marked.indexOf('|')
  const end = marked.indexOf('|', start + 1) - 1
  return { raw: marked.replace(/\|/g, ''), start, end }
}

/**
 * `body`, run on a machine whose own locale is `tag` — as far as a `Segmenter`
 * built with no locale can report it, which is how the machine's language
 * reached the merge gate. Restored whatever `body` does.
 */
function onHost<T>(tag: string, body: () => T): T {
  const real = Intl.Segmenter.prototype.resolvedOptions
  const spy = vi.spyOn(Intl.Segmenter.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.Segmenter,
  ) {
    return { ...real.call(this), locale: tag }
  })
  try {
    /* Non-vacuity: the stand-in is what the host reports. */
    expect(new Intl.Segmenter(undefined, { granularity: 'sentence' }).resolvedOptions().locale).toBe(tag)
    return body()
  } finally {
    spy.mockRestore()
  }
}

describe('what the abbreviation merge may not cross', () => {
  /* ⚠️ **U+2028 IS PRESERVED ON PURPOSE AND THE MERGE ATE IT.** `squeeze`
     collapses everything CSS collapses and deliberately keeps U+2028/U+2029,
     because CSS does not collapse them and the reader sees a line break there.
     `TITLE`/`INITIAL` ended in `\s*`, which matches those — so ICU's correct
     split at the separator was merged straight back. */
  it('does not merge across a line separator', () => {
    const { raw, start, end } = around('He lived on Main St.\u2028Beta |two| words here.')
    const found = sentenceOf(raw, start, end, { locale: 'en', requireComplete: false })

    expect(found.ok).toBe(true)
    if (found.ok) {
      expect(found.sentence).not.toContain('Main St.')
      expect(found.sentence).toContain('Beta two')
    }
  })

  /* NON-VACUITY: an ordinary space after the title still merges, which is the
     whole reason the merge pass exists. */
  it('still merges a title across an ordinary space', () => {
    const { raw, start, end } = around('He met Mr. |Smith| at noon. Then left.')
    const found = sentenceOf(raw, start, end, { locale: 'en', requireComplete: false })

    expect(found.ok).toBe(true)
    if (found.ok) expect(found.sentence).toBe('He met Mr. Smith at noon.')
  })
})

/* PHASE 17, L8: what lies across the edges is squeezed and segmented too, so it
   counts against the work bound — a 64 kB paragraph beside the term would
   otherwise be segmented synchronously on the selection path. */
describe('the work bound, counting what lies across the edges', () => {
  const raw = 'Alpha one. Beta two. Gamma three.'

  it('refuses a far side that takes the work past the bound, on either edge', () => {
    const far = 'x'.repeat(MAX_RUN_CHARS - raw.length + 1)

    expect(sentenceOf(raw, 11, 15, { before: far })).toEqual({ ok: false, gap: 'too-long' })
    expect(sentenceOf(raw, 11, 15, { after: far })).toEqual({ ok: false, gap: 'too-long' })
  })

  it('does the work at exactly the bound', () => {
    const far = 'x'.repeat(MAX_RUN_CHARS - raw.length)
    const answer = { ok: true, sentence: 'Beta two.', term: 'Beta' }

    expect(sentenceOf(raw, 11, 15, { before: far })).toEqual(answer)
    expect(sentenceOf(raw, 11, 15, { after: far })).toEqual(answer)
  })
})

/* THE REASON IS PART OF THE ANSWER. `Diagnostics` counts the gap, and the
   corpus reads only whether there was a sentence — so a decline that lost its
   reason, or its shape, would pass every row there. */
describe('the reason an edge sentence is declined', () => {
  const raw = 'Alpha one. Beta two. Gamma three.'

  it('says the run starts there when nothing is known before it, or the text before does not end a sentence', () => {
    expect(sentenceOf(raw, 0, 5)).toEqual({ ok: false, gap: 'run-start' })
    expect(sentenceOf(raw, 0, 5, { before: 'He went to the' })).toEqual({ ok: false, gap: 'run-start' })
  })

  it('says the run ends there when nothing is known after it, or the text after does not start a sentence', () => {
    expect(sentenceOf(raw, 27, 32)).toEqual({ ok: false, gap: 'run-end' })
    expect(sentenceOf(raw, 27, 32, { after: 'and then more' })).toEqual({ ok: false, gap: 'run-end' })
  })

  /* The merge pass reads every segment, the run's LAST included — so a run
     ending in a title must not move where its first sentence starts. */
  it('says the run starts there when the run ends in a title', () => {
    expect(sentenceOf('Alpha one. He met Mr.', 0, 5)).toEqual({ ok: false, gap: 'run-start' })
  })
})

/* THE REASON IS PART OF THE ANSWER, and there are two for a run with nothing in
   it: offsets that are wrong, and offsets that are right about an empty run. The
   caller's mistake is named first — a run that squeezes to nothing would
   otherwise hide every wrong offset handed with it. */
describe('which refusal comes first', () => {
  const blank = '   '

  it('names a wrong term before an empty run, whichever bound is wrong', () => {
    for (const [start, end] of [
      [-1, 2],
      [0.5, 2],
      [0, 1.5],
      [0, 4],
      [2, 1],
      [1, 1],
    ]) {
      expect(sentenceOf(blank, start as number, end as number)).toEqual({ ok: false, gap: 'no-term' })
    }
  })

  it('names the empty run when the term is in range, up to the run’s own end', () => {
    expect(sentenceOf(blank, 0, 3)).toEqual({ ok: false, gap: 'empty' })
    expect(sentenceOf(blank, 1, 2)).toEqual({ ok: false, gap: 'empty' })
  })

  /* A term ending exactly where the run ends is in range: that offset is the
     one the squeeze reaches last. */
  it('answers a term that ends exactly where the run does', () => {
    expect(sentenceOf('Alpha one. Beta two.', 16, 20, { requireComplete: false })).toEqual({
      ok: true,
      sentence: 'Beta two.',
      term: 'two.',
    })
  })
})

/** U+2028, built rather than typed — see AGENTS.md on escapes typed into an edit. */
const LINE_SEPARATOR = String.fromCharCode(0x2028)

describe('what the squeeze keeps and drops', () => {
  /* A term in whitespace that nothing kept follows is no term — not the text
     before it, which is where a start found too early would land. */
  it('refuses a term in the run’s trailing whitespace', () => {
    expect(sentenceOf('Alpha one. Beta two.   ', 20, 22, { requireComplete: false })).toEqual({
      ok: false,
      gap: 'no-term',
    })
  })

  it('collapses white space and nothing else, a capital V included', () => {
    const { raw, start, end } = around('Alpha one.\t\v\f|Very| well. Beta two.')
    expect(sentenceOf(raw, start, end)).toEqual({ ok: true, sentence: 'Very well.', term: 'Very' })
  })

  /* A separator cancels the space owed before it, or the space survives into
     the sentence either side of the line break. */
  it('leaves no space before a separator inside the sentence', () => {
    const raw = `Prior. Alpha one. ${LINE_SEPARATOR}Beta two. Last.`
    const start = raw.indexOf('one')
    const end = raw.indexOf('Beta') + 4

    expect(sentenceOf(raw, start, end, { locale: 'en' })).toEqual({
      ok: true,
      sentence: `Alpha one.${LINE_SEPARATOR}Beta two.`,
      term: `one.${LINE_SEPARATOR}Beta`,
    })
  })
})

/* WHAT LIES ACROSS AN EDGE ARRIVES AS THE DOCUMENT WROTE IT — indented, with
   line breaks of its own — and is squeezed like the run before the seam is
   looked for. */
describe('the far side of an edge, as a document writes it', () => {
  const raw = 'Beta two. Gamma three.'

  it('confirms an edge whose far side is indented, as pretty-printed XHTML is', () => {
    expect(sentenceOf(raw, 10, 15, { locale: 'en', after: '\n    Delta four.' })).toEqual({
      ok: true,
      sentence: 'Gamma three.',
      term: 'Gamma',
    })
  })

  it('confirms an edge after a line break with white space behind it', () => {
    expect(sentenceOf(raw, 0, 4, { locale: 'en', before: `Alpha one.${LINE_SEPARATOR}\n  ` })).toEqual({
      ok: true,
      sentence: 'Beta two.',
      term: 'Beta',
    })
  })

  /* Only a separator AT the seam takes the space's place. One further in is a
     line break inside the far paragraph, and the seam is still a space. */
  it('joins the seam with a space when the far side’s line break is not at it', () => {
    expect(sentenceOf(raw, 0, 4, { locale: 'en', before: `Zeta.${LINE_SEPARATOR}Alpha one.` })).toEqual({
      ok: true,
      sentence: 'Beta two.',
      term: 'Beta',
    })
    expect(sentenceOf(raw, 10, 15, { locale: 'en', after: `Delta four.${LINE_SEPARATOR}Epsilon.` })).toEqual({
      ok: true,
      sentence: 'Gamma three.',
      term: 'Gamma',
    })
  })

  /* ⚠️ THE SEAM IS PAST EVERY SEPARATOR THE FAR SIDE OPENS WITH, and one ICU is
     not the reason. Node's breaks after each separator (UAX #29 SB4), so
     counting one or all of them looks the same there; WebKit on macOS runs the
     system ICU, which need not. The stand-in keeps a run of separators together
     and breaks only after the last. */
  it('confirms an edge past every separator the far side opens with, on an engine that keeps a run of them together', () => {
    const paragraphSeparator = String.fromCharCode(0x2029)
    const onlySeparators = (segment: string) =>
      [...segment].every((character) => character === LINE_SEPARATOR || character === paragraphSeparator)
    const real = Intl.Segmenter.prototype.segment
    const spy = vi.spyOn(Intl.Segmenter.prototype, 'segment').mockImplementation(function (
      this: Intl.Segmenter,
      input: string,
    ) {
      const parts: Intl.SegmentData[] = []
      for (const part of real.call(this, input)) {
        const previous = parts[parts.length - 1]
        if (previous && onlySeparators(part.segment)) {
          parts[parts.length - 1] = { ...previous, segment: `${previous.segment}${part.segment}` }
        } else {
          parts.push(part)
        }
      }
      return parts as unknown as Intl.Segments
    })
    try {
      const tail = `${LINE_SEPARATOR}${paragraphSeparator}Delta four.`
      /* Non-vacuity: the stand-in breaks after the run and not inside it, where Node's ICU breaks at 13 as well. */
      const indices = [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(`Gamma three.${tail}`)].map(
        (part) => part.index,
      )
      expect(indices).toEqual([0, 14])

      expect(sentenceOf(raw, 10, 15, { locale: 'en', after: tail })).toEqual({
        ok: true,
        sentence: 'Gamma three.',
        term: 'Gamma',
      })
    } finally {
      spy.mockRestore()
    }
  })

  /* ICU breaks after a separator whatever follows it (UAX #29 SB4), so the edge
     is confirmed however the next line opens — here with the full stops that
     would otherwise carry a sentence on (SB8a). */
  it('confirms an edge at a line break, whatever the next line opens with', () => {
    expect(sentenceOf(`${raw}${LINE_SEPARATOR}`, 10, 15, { locale: 'en', after: '...and silence.' })).toEqual({
      ok: true,
      sentence: 'Gamma three.',
      term: 'Gamma',
    })
  })
})

/* EACH PATTERN READS A SEGMENT'S TAIL, AND ONLY ITS TAIL — anchored at the end,
   with zero or more spaces after the stop. */
describe('where the merge patterns look', () => {
  const sentenceFor = (marked: string) => {
    const { raw, start, end } = around(`Alpha one. ${marked} Beta two.`)
    return sentenceOf(raw, start, end, { locale: 'en' })
  }

  it('reads a title that opens the run', () => {
    const { raw, start, end } = around('Mr. |Smith| went home. Beta two.')
    expect(sentenceOf(raw, start, end, { locale: 'en', before: null })).toEqual({
      ok: true,
      sentence: 'Mr. Smith went home.',
      term: 'Smith',
    })
  })

  /* ICU breaks straight after the stop when a footnote mark follows it, so the
     segment ends in `Dr.` with no space at all. */
  it('reads a title or an initial with no space after its stop', () => {
    expect(sentenceFor('He met Dr.* |Smith| today.')).toEqual({
      ok: true,
      sentence: 'He met Dr.* Smith today.',
      term: 'Smith',
    })
    expect(sentenceFor('He met J.* |Smith| today.')).toEqual({
      ok: true,
      sentence: 'He met J.* Smith today.',
      term: 'Smith',
    })
  })

  /* ICU does not split before a lowercase word after a full stop (SB8), so this
     `A.` sits INSIDE a segment — which must not make that segment end in one. */
  it('reads no initial from inside a segment', () => {
    expect(sentenceFor('He wrote the letter A. and |left|.')).toEqual({
      ok: true,
      sentence: 'He wrote the letter A. and left.',
      term: 'left',
    })
  })

  it('reads no quotation from inside a segment', () => {
    expect(sentenceFor('He cried "Stop!", and ran! then |left|.')).toEqual({
      ok: true,
      sentence: 'then left.',
      term: 'left',
    })
  })

  it('reads a quotation closed by more than one mark, or by one with no space after it', () => {
    expect(sentenceFor('She wrote (“Stop!”) and |left|.')).toEqual({
      ok: true,
      sentence: 'She wrote (“Stop!”) and left.',
      term: 'left',
    })
    expect(sentenceFor('“Stop!”he |said|.')).toEqual({ ok: true, sentence: '“Stop!”he said.', term: 'said' })
  })
})

describe('what an out-of-range term does', () => {
  /* ⚠️ **`squeeze` CLAMPS, SO A WRONG OFFSET USED TO BE ANSWERED.** Under §C1
     the damage mostly ended as a `run-end` gap and was invisible; with
     `requireComplete: false` there is no gate, so a `termEnd` past the run
     returned a confident sentence spanning everything to its end. */
  it('refuses a term that runs past the text', () => {
    const raw = 'One sentence. Two sentence. Three.'
    expect(sentenceOf(raw, 4, raw.length + 10, { requireComplete: false })).toEqual({
      ok: false,
      gap: 'no-term',
    })
  })

  it('refuses a negative, inverted, or empty term', () => {
    const raw = 'One sentence. Two sentence. Three.'
    for (const [start, end] of [
      [-1, 5],
      [10, 4],
      [5, 5],
      [1.5, 6],
    ]) {
      expect(sentenceOf(raw, start as number, end as number, { requireComplete: false })).toEqual({
        ok: false,
        gap: 'no-term',
      })
    }
  })

  /* NON-VACUITY: an in-range term is still answered. */
  it('answers an in-range term', () => {
    const { raw, start, end } = around('One sentence. Two |sentence| here. Three.')
    expect(sentenceOf(raw, start, end, { requireComplete: false }).ok).toBe(true)
  })
})

/* ⚠️ LINEAR, AND IT WAS QUADRATIC. The merge pass asked whether the WHOLE span
   merged so far ends in an abbreviation, once per segment, so a chain of
   initials re-read every character before it at every step: `J. ` twenty-one
   thousand times is under `MAX_RUN_CHARS` and took seconds to decline,
   synchronously, on the selection path. The observable is how much text the
   patterns are handed — not the clock, which proves nothing on a loaded machine. */
describe('what the abbreviation merge costs', () => {
  it('hands the patterns each segment once, however long the chain of initials', () => {
    const raw = `${'J. '.repeat(21_000)}End.`
    expect(raw.length).toBeLessThan(MAX_RUN_CHARS)

    const spy = vi.spyOn(RegExp.prototype, 'test')
    let answer: unknown
    let inputs: number[] = []
    try {
      answer = sentenceOf(raw, raw.length - 4, raw.length - 1, { locale: 'en' })
      inputs = spy.mock.calls.map(([input]) => String(input).length)
    } finally {
      spy.mockRestore()
    }

    expect(answer).toEqual({ ok: false, gap: 'run-start' })
    /* Non-vacuity: the patterns ARE asked through `test`, about more than one character at a time. */
    expect(inputs.some((length) => length > 1)).toBe(true)
    expect(inputs.reduce((total, length) => total + length, 0)).toBeLessThan(10 * raw.length)
  })

  /* The same bound on the path with no language declared, which asks each
     segment's SCRIPT as well — and asked of the merged span, that question
     would be the quadratic read above arriving a second time. */
  it('hands the script check each segment once too, when no language is declared', () => {
    const raw = `${'J. '.repeat(21_000)}End.`

    const spy = vi.spyOn(RegExp.prototype, 'test')
    let answer: unknown
    let inputs: number[] = []
    try {
      answer = sentenceOf(raw, raw.length - 4, raw.length - 1)
      inputs = spy.mock.calls.map(([input]) => String(input).length)
    } finally {
      spy.mockRestore()
    }

    expect(answer).toEqual({ ok: false, gap: 'run-start' })
    expect(inputs.some((length) => length > 1)).toBe(true)
    expect(inputs.reduce((total, length) => total + length, 0)).toBeLessThan(10 * raw.length)
  })
})

/* ⚠️ **THE MACHINE DECIDED WHETHER `Mr.` ENDED A SENTENCE**, for every book that
   declares no language. The gate asked the SYSTEM's locale in that case, so the
   same English text merged on an en-US Mac and was cut after `Mr.` on a machine
   set to Chinese. Measured 2026-09-14 on Windows 11, default locale zh-CN, ICU
   78.3: `useGloss.test.ts`'s fallback answered `Smith at noon.` for
   `He met Mr. Smith at noon.`, and `sentenceAt.test.ts` vouched for
   `Smith today.` across a paragraph ending `He met Mr.`. Both passed on the Mac
   and both failed there under `LC_ALL=zh_CN.UTF-8`. ICU itself splits after
   `Mr.` identically under `undefined`, `en` and `zh-CN` — the lookup was the only
   dependence. `onHost` stands in for the machine, so this fails on any of them. */
describe('a book that declares no language', () => {
  it('merges a Latin title, initials and a run-on quotation on a machine whose own language is not Latin', () => {
    onHost('zh-CN', () => {
      const title = around('He met Mr. |Smith| at noon. Then left.')
      expect(sentenceOf(title.raw, title.start, title.end, { requireComplete: false })).toEqual({
        ok: true,
        sentence: 'He met Mr. Smith at noon.',
        term: 'Smith',
      })

      const initials = around('Alpha one. He met J. R. |Smith| today. Beta two.')
      expect(sentenceOf(initials.raw, initials.start, initials.end)).toEqual({
        ok: true,
        sentence: 'He met J. R. Smith today.',
        term: 'Smith',
      })

      const quoted = around('Alpha one. He said, “Stop!” he |said|. Beta two.')
      expect(sentenceOf(quoted.raw, quoted.start, quoted.end)).toEqual({
        ok: true,
        sentence: 'He said, “Stop!” he said.',
        term: 'said',
      })
    })
  })

  it('confirms no edge the merge would take back, on a machine whose own language is not Latin', () => {
    onHost('zh-CN', () => {
      expect(sentenceOf('Smith today. Beta two.', 0, 5, { before: 'He met Mr.' })).toEqual({
        ok: false,
        gap: 'run-start',
      })
      expect(sentenceOf('Alpha one. He met Mr.', 18, 20, { after: 'Smith today.' })).toEqual({
        ok: false,
        gap: 'run-end',
      })
      /* Non-vacuity: a full stop that does end a sentence still confirms either edge. */
      expect(sentenceOf('Smith today. Beta two.', 0, 5, { before: 'He met Jones.' })).toEqual({
        ok: true,
        sentence: 'Smith today.',
        term: 'Smith',
      })
      expect(sentenceOf('Alpha one. He met Jones.', 18, 23, { after: 'Smith today.' })).toEqual({
        ok: true,
        sentence: 'He met Jones.',
        term: 'Jones',
      })
    })
  })

  /* FAIL CLOSED STILL, now on the text rather than on the machine: `INITIAL` is
     any capital, and the merge is Latin orthography. A segment carrying a single
     letter from another script is not Latin text — so a Cyrillic capital inside
     an English sentence is not taken for an initial either. */
  it('takes no Cyrillic or Greek capital for a Latin initial, on a machine whose own language is Latin', () => {
    onHost('en-US', () => {
      const cyrillic = around('Alpha one. Он встретил А. |Смирнова| сегодня. Beta two.')
      expect(sentenceOf(cyrillic.raw, cyrillic.start, cyrillic.end)).toEqual({
        ok: true,
        sentence: 'Смирнова сегодня.',
        term: 'Смирнова',
      })

      const greek = around('Alpha one. Ο Γ. |Παπαδόπουλος| ήρθε. Beta two.')
      expect(sentenceOf(greek.raw, greek.start, greek.end)).toEqual({
        ok: true,
        sentence: 'Παπαδόπουλος ήρθε.',
        term: 'Παπαδόπουλος',
      })

      const mixed = around('Alpha one. He met Ж. |Smith| today. Beta two.')
      expect(sentenceOf(mixed.raw, mixed.start, mixed.end)).toEqual({
        ok: true,
        sentence: 'Smith today.',
        term: 'Smith',
      })
    })
  })

  /* ⚠️ **AND THE QUESTION IS THE ABBREVIATION, NOT THE SENTENCE AROUND IT**
     (found by review, 2026-09-14). Asked of the whole segment, one Greek
     variable took the merge away from the Latin `Dr.` ending it, and this
     returned `Smith at noon.` — the same cut the machine used to make, reached
     through the text instead. A Greek variable, a Han name or a quoted foreign
     word is ordinary in an English sentence; the tail is what the patterns
     read, so the tail is what answers. */
  it('merges a Latin title at the end of a sentence that holds another script', () => {
    onHost('en-US', () => {
      const greek = around('Before. He discussed α with Dr. |Smith| at noon. After.')
      expect(sentenceOf(greek.raw, greek.start, greek.end)).toEqual({
        ok: true,
        sentence: 'He discussed α with Dr. Smith at noon.',
        term: 'Smith',
      })

      const han = around('Before. He read 中庸 with Prof. |Smith| at noon. After.')
      expect(sentenceOf(han.raw, han.start, han.end)).toEqual({
        ok: true,
        sentence: 'He read 中庸 with Prof. Smith at noon.',
        term: 'Smith',
      })
    })
  })

  /* TWO TAILS THAT ARE EASY TO GET WRONG. A stop with no space after it ends a
     segment too — ICU breaks straight after `Dr.` when a footnote mark follows —
     and that tail must still be read. A segment ending in a line separator has
     no tail at all, since `\S` does not match one, and must be answered with no
     merge rather than with a throw. Both asked with no language declared, which
     is the only time the tail is read. */
  it('reads a tail with no space after its stop, and refuses one that ends in a line break', () => {
    onHost('zh-CN', () => {
      const footnoted = around('Alpha one. He met Dr.* |Smith| today. Beta two.')
      expect(sentenceOf(footnoted.raw, footnoted.start, footnoted.end)).toEqual({
        ok: true,
        sentence: 'He met Dr.* Smith today.',
        term: 'Smith',
      })

      const raw = `He lived on Main St.${LINE_SEPARATOR}Beta two words here.`
      const start = raw.indexOf('two')
      expect(sentenceOf(raw, start, start + 3, { requireComplete: false })).toEqual({
        ok: true,
        sentence: 'Beta two words here.',
        term: 'two',
      })
    })
  })

  /* `µ` IS A LETTER AND BELONGS TO NO SCRIPT. It is `Common`, like `ʼ` and `ℕ`,
     and an English sentence measuring `5 µm` is still English. */
  it('counts a letter that belongs to no one script against nothing', () => {
    onHost('zh-CN', () => {
      const { raw, start, end } = around('Alpha one. The cell is 5 µm wide, said Dr. |Smith| today. Beta two.')
      expect(sentenceOf(raw, start, end)).toEqual({
        ok: true,
        sentence: 'The cell is 5 µm wide, said Dr. Smith today.',
        term: 'Smith',
      })
    })
  })

  /* The segment that ENDS in the title is the one asked: what follows a Latin
     `Mr.` is a name, in whatever script it is written. */
  it('asks the segment the title ends, not the one after it', () => {
    onHost('en-US', () => {
      const { raw, start, end } = around('Alpha one. He met Mr. |Смирнов| today. Beta two.')
      expect(sentenceOf(raw, start, end)).toEqual({ ok: true, sentence: 'He met Mr. Смирнов today.', term: 'Смирнов' })
    })
  })

  /* A segment with no letters has no script to be Latin in, and unknown does not
     get the merge. */
  it('does not merge after a segment with no letters in it', () => {
    onHost('en-US', () => {
      const { raw, start, end } = around('Alpha one. "42!" he |said|. Beta two.')
      expect(sentenceOf(raw, start, end)).toEqual({ ok: true, sentence: 'he said.', term: 'said' })
      /* Non-vacuity: a declared Latin language merges exactly this. */
      expect(sentenceOf(raw, start, end, { locale: 'en' })).toEqual({ ok: true, sentence: '"42!" he said.', term: 'said' })
    })
  })

  /* ⚠️ THE CATCH IS FOR ENGINES THIS ONE IS NOT. V8 refuses exactly the same
     tags in `Intl.Segmenter` and `Intl.Locale` — measured 2026-09-14 over
     thirty-eight — so nothing under Node reaches it. WebKit on the system ICU,
     and WebView2, are what run this; a tag their segmenter accepted and their
     `Intl.Locale` refused would throw inside the reader's lookup. The stand-in
     is such an engine, and what it must get is the fail-closed answer. */
  it('fails closed on a tag the segmenter accepted and Intl.Locale refuses', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Locale') as PropertyDescriptor
    class Refusing extends Intl.Locale {
      constructor(tag: string | Intl.Locale, options?: Intl.LocaleOptions) {
        if (tag === 'fr') throw new RangeError('Incorrect locale information provided')
        super(tag, options)
      }
    }
    Object.defineProperty(Intl, 'Locale', { ...descriptor, value: Refusing })
    try {
      /* Non-vacuity: the stand-in refuses `fr`, and the segmenter still takes it. */
      expect(() => new Intl.Locale('fr')).toThrow(RangeError)
      expect(new Intl.Segmenter('fr', { granularity: 'sentence' }).resolvedOptions().locale).toBe('fr')

      const { raw, start, end } = around('Alpha one. He met Mr. |Smith| today. Beta two.')
      expect(sentenceOf(raw, start, end, { locale: 'fr' })).toEqual({ ok: true, sentence: 'Smith today.', term: 'Smith' })
      /* Non-vacuity: a Latin tag the stand-in does not refuse merges. */
      expect(sentenceOf(raw, start, end, { locale: 'fr-FR' })).toEqual({
        ok: true,
        sentence: 'He met Mr. Smith today.',
        term: 'Smith',
      })
    } finally {
      Object.defineProperty(Intl, 'Locale', descriptor)
    }
  })

  /* ⚠️ THE LIST OF TAGS MEANING "NOT A LANGUAGE" IS FOR ENGINES THIS ONE IS NOT.
     V8 reports `new Intl.Locale('und').language` as `undefined`, which the first
     clause catches; ECMA-402's getter reports `'und'`. And `mul` and `zxx` get no
     script here only because this ICU's likely-subtags data has no row for them.
     A tag MEANING "no language" is refused before that data is asked — so the
     stand-in is an engine with both: `und` spelled out, and every tag
     maximizing to Latin. */
  it('refuses a tag meaning “not a language” before asking what it maximizes to', () => {
    const language = Object.getOwnPropertyDescriptor(Intl.Locale.prototype, 'language')?.get
    const spelled = vi.spyOn(Intl.Locale.prototype, 'language', 'get').mockImplementation(function (
      this: Intl.Locale,
    ) {
      return (language?.call(this) as string | undefined) ?? 'und'
    })
    const everyTagLatin = vi
      .spyOn(Intl.Locale.prototype, 'maximize')
      .mockImplementation(() => new Intl.Locale('en-Latn-US'))
    try {
      const { raw, start, end } = around('Alpha one. He met Mr. |Smith| today. Beta two.')
      /* Non-vacuity: under this data, an unknown tag that is NOT one of them merges. */
      expect(sentenceOf(raw, start, end, { locale: 'qqq' })).toEqual({
        ok: true,
        sentence: 'He met Mr. Smith today.',
        term: 'Smith',
      })
      for (const locale of ['und', 'mul', 'zxx']) {
        expect(sentenceOf(raw, start, end, { locale })).toEqual({ ok: true, sentence: 'Smith today.', term: 'Smith' })
      }
    } finally {
      spelled.mockRestore()
      everyTagLatin.mockRestore()
    }
  })

  /* A DECLARED LANGUAGE KEEPS THE LANGUAGE'S RULE, whatever the text: `en` merges
     a Cyrillic initial, and a tag meaning "not a language" merges nothing. */
  it('leaves a declared language to decide, text and machine alike', () => {
    onHost('zh-CN', () => {
      const cyrillic = around('Alpha one. Он встретил А. |Смирнова| сегодня. Beta two.')
      expect(sentenceOf(cyrillic.raw, cyrillic.start, cyrillic.end, { locale: 'en' })).toEqual({
        ok: true,
        sentence: 'Он встретил А. Смирнова сегодня.',
        term: 'Смирнова',
      })

      const latin = around('Alpha one. He met Mr. |Smith| today. Beta two.')
      for (const locale of ['ru', 'zh', 'und', 'mul', 'zxx']) {
        expect(sentenceOf(latin.raw, latin.start, latin.end, { locale })).toEqual({
          ok: true,
          sentence: 'Smith today.',
          term: 'Smith',
        })
      }
    })
  })
})

/* ⚠️ ICU ENDS A SENTENCE STRAIGHT AFTER U+2028 AND U+2029, and the seam was
   joined with a space regardless — so the break fell one character before the
   place it was looked for, and a line break the reader can see was declined as
   an edge nothing could be said about. */
describe('a mandatory separator at the seam', () => {
  const raw = 'Beta two. Gamma three.'

  it.each([
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ])('confirms an edge across a %s, on either side of the seam', (_, separator) => {
    expect(sentenceOf(raw, 0, 4, { locale: 'en', before: `Alpha one.${separator}` })).toEqual({
      ok: true,
      sentence: 'Beta two.',
      term: 'Beta',
    })
    expect(sentenceOf(raw, 10, 15, { locale: 'en', after: `${separator}Delta four.` })).toEqual({
      ok: true,
      sentence: 'Gamma three.',
      term: 'Gamma',
    })
    expect(sentenceOf(`${raw}${separator}`, 10, 15, { locale: 'en', after: 'Delta four.' })).toEqual({
      ok: true,
      sentence: 'Gamma three.',
      term: 'Gamma',
    })
  })
})

/* A SEPARATOR SURVIVES THE SQUEEZE, SO IT COULD BE THE TERM. `squeeze` keeps
   U+2028 and U+2029 on purpose, and nothing took them off the term's edges: a
   selection of the separator alone was answered with the sentence before it, and
   one ending on it sent a term the sentence does not contain. */
describe('mandatory separators at the edges of the term', () => {
  const raw = 'Prior. Alpha one.\u2028Beta two. Last.'
  const separator = raw.indexOf('\u2028')

  it('refuses a term that is nothing but a separator', () => {
    expect(sentenceOf(raw, separator, separator + 1, { locale: 'en' })).toEqual({ ok: false, gap: 'no-term' })
    expect(sentenceOf(raw.replace('\u2028', '\u2029'), separator, separator + 1, { locale: 'en' })).toEqual({
      ok: false,
      gap: 'no-term',
    })
  })

  it('takes a separator off either edge of the term, and chooses the sentence from what is left', () => {
    expect(sentenceOf(raw, separator - 4, separator + 1, { locale: 'en' })).toEqual({
      ok: true,
      sentence: 'Alpha one.',
      term: 'one.',
    })
    expect(sentenceOf(raw, separator, separator + 5, { locale: 'en' })).toEqual({
      ok: true,
      sentence: 'Beta two.',
      term: 'Beta',
    })
    /* Non-vacuity: a separator INSIDE the term is the reader's, and stays. */
    expect(sentenceOf(raw, separator - 4, separator + 5, { locale: 'en' })).toEqual({
      ok: true,
      sentence: 'Alpha one.\u2028Beta two.',
      term: 'one.\u2028Beta',
    })
  })
})

/* ICU ends a sentence after `!"` or `?)` whatever follows — UAX #29 keeps a
   lowercase continuation with the sentence before it only after a full stop
   (SB8) — so the attribution after quoted speech came back as a sentence of its
   own. */
describe('a quotation that runs on in lower case', () => {
  it.each([
    ['He said, “Stop!” he said.', 'said'],
    ['"Is it?" she asked.', 'asked'],
    ["'Run!' they cried.", 'cried'],
    ['He ran (fast!) and left.', 'left'],
  ])('keeps %s whole', (sentence, word) => {
    const raw = `Alpha one. ${sentence} Beta two.`
    const start = raw.lastIndexOf(word)

    expect(sentenceOf(raw, start, start + word.length, { locale: 'en' })).toEqual({ ok: true, sentence, term: word })
  })

  /* NON-VACUITY: a capital after the quotation is a new sentence, as it was. */
  it('still ends the sentence before a capital', () => {
    const raw = 'Alpha one. "Stop!" He left. Beta two.'
    const start = raw.indexOf('left')

    expect(sentenceOf(raw, start, start + 4, { locale: 'en' })).toEqual({ ok: true, sentence: 'He left.', term: 'left' })
  })
})

/* A CAP THAT IS NOT A WHOLE NUMBER CAPS NOTHING. `length > NaN` is false for
   every length, so `maxSentenceChars: NaN` switched the guard off — and a caller
   that computed its cap wrongly must be told, not answered. */
describe('the sentence cap', () => {
  const sentence = `W${'x'.repeat(1_099)}.`
  const raw = `Alpha one. ${sentence} Beta two.`

  it('refuses a cap that is not a whole number, rather than measuring against it', () => {
    for (const maxSentenceChars of [Number.NaN, Number.POSITIVE_INFINITY, 1_200.5]) {
      expect(sentenceOf(raw, 11, 12, { locale: 'en', maxSentenceChars })).toEqual({ ok: false, gap: 'too-long' })
    }
  })

  it('measures against a whole-number cap, on either side of the sentence’s length', () => {
    expect(sentenceOf(raw, 11, 12, { locale: 'en' })).toEqual({ ok: false, gap: 'too-long' })
    expect(sentenceOf(raw, 11, 12, { locale: 'en', maxSentenceChars: 1_101 })).toEqual({ ok: true, sentence, term: 'W' })
    expect(sentenceOf(raw, 11, 12, { locale: 'en', maxSentenceChars: 1_100 })).toEqual({ ok: false, gap: 'too-long' })
  })
})
