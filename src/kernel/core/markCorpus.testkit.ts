import { DEFAULT_MAX_CHARS } from '../ui/reader/wordSnap/flatten'

/**
 * Three builds of one work, and a hand-labelled table of the passages they
 * share (WI-21.P2).
 *
 * ## What this is for
 *
 * Every claim phase 21 makes is a claim about ONE PASSAGE IN TWO BUILDS: that a
 * CFI written against one download of a book addresses different words in
 * another, that a quote alone cannot say which occurrence it is, that the
 * context either side is what makes it re-findable. None of those can be argued
 * against a single fixture, because a single fixture cannot drift.
 *
 * So this is the smallest thing that can disagree with itself: the same prose,
 * set three ways, with a table saying which passage in build A is which passage
 * in build B — read by a person, not derived.
 *
 * ## Why it is synthesised rather than downloaded
 *
 * ⚠️ **It must load in a test with NO NETWORK and NO REAL SHELF.** That is the
 * rule `scripts/scan-corpus.mjs` sets — *"the suite beside it tests the analysis
 * against fixtures and never the real shelf"* — and it is the reason the real
 * Gutenberg, Standard Ebooks and commercial files are not vendored here: a test
 * that fetches is a test that fails on an aeroplane, and a hundred megabytes of
 * EPUB in the repository is a hundred megabytes every clone pays for.
 *
 * What is reproduced is what the passages TURN ON — a different spine, a
 * different set of front matter, different typography, a script element in one
 * build and not the others. The build names say which real publisher's habits
 * each imitates.
 *
 * ## The falsifier
 *
 * `buildFile` renders each build to bytes. **If two of the three hash the same,
 * the corpus proves nothing about drift and must be rebuilt** — a corpus whose
 * builds agree is three copies of one fixture wearing three names.
 * `markCorpus.test.ts` is where that runs.
 */

/** Which build. The names are the publishing habits each imitates. */
export type BuildId = 'gutenberg' | 'standard-ebooks' | 'commercial'

export const BUILD_IDS: readonly BuildId[] = ['gutenberg', 'standard-ebooks', 'commercial']

/**
 * What a passage pair is in the corpus to catch.
 *
 * NAMED RATHER THAN COUNTED, for `FIXTURE_SHAPES`' reason: a failure says WHICH
 * hazard stopped being covered, and a corpus that quietly lost one is exactly
 * what a count cannot see.
 */
export type CorpusHazard =
  /** The same chapter sits at a different spine index in each build. */
  | 'spine-index-differs'
  /** The quote occurs more than once, so the quote alone cannot place it. */
  | 'occurs-more-than-once'
  /** Front matter every build carries — the text most likely to false-match. */
  | 'boilerplate'
  /** Straight quotes and an unspaced em-dash against curly and spaced. */
  | 'typography'
  /** Past `flatten`'s 20 000-character bound, where the walk gives up. */
  | 'past-flatten-bound'
  /** In a section carrying a `<script>`, which Paper strips before rendering. */
  | 'section-has-script'

export const CORPUS_HAZARDS: readonly CorpusHazard[] = [
  'spine-index-differs',
  'occurs-more-than-once',
  'boilerplate',
  'typography',
  'past-flatten-bound',
  'section-has-script',
]

export interface CorpusSection {
  readonly href: string
  readonly xhtml: string
}

export interface CorpusBuild {
  readonly id: BuildId
  /**
   * The id a library would give this file — derived from bytes, so no two
   * builds share one. This is the whole reason an archive from build A does
   * not id-match build B.
   */
  readonly bookId: string
  readonly title: string
  readonly author: string
  /**
   * `dc:identifier`, as each build declares it.
   *
   * The three do NOT agree, and that is the fact WI-21.3 exists against:
   * Gutenberg mints its own URI, Standard Ebooks mints another, and only the
   * commercial build carries the ISBN. A work key derived from these has to
   * cope with all three saying different things about one work.
   */
  readonly identifier: string
  /**
   * BLAKE3 of the whole file, as `BookRecord.contentHash` carries it.
   *
   * Distinct from `bookId` and STRICTLY STRONGER: `bookId` is sampled above
   * 64 MiB and two different files can share one, where this is the whole
   * file's digest. The corpus carries both so a test can tell "the shelf holds
   * the same book" from "the shelf holds the same BYTES", which is the
   * distinction phase 21 Stage 1's import rule turns on.
   */
  readonly contentHash: string
  /** The spine, in order. The index into this array IS `sectionIndex`. */
  readonly sections: readonly CorpusSection[]
}

/** Where one passage sits in one build. */
export interface PassagePlace {
  readonly sectionIndex: number
  /**
   * The anchor, as this build's reader would write it.
   *
   * HAND-LABELLED, and labelled against the RENDERED document — the one Paper
   * draws, after `refuseBookScripts` has stripped the scripts. That distinction
   * is WI-21.P1's whole subject: before it was fixed, foliate computed search
   * CFIs against the raw document and the two disagreed by one sibling index
   * for everything after a `<script>`.
   */
  readonly cfi: string
  /** The words, exactly as THIS build sets them. */
  readonly quote: string
  /** Which occurrence of `quote` in the section, 1-based. */
  readonly occurrence: number
  /** The 32 characters either side, as `markContext` would capture them. */
  readonly prefix: string
  readonly suffix: string
}

export interface CorpusPassage {
  readonly id: string
  readonly covers: CorpusHazard
  /**
   * Why these are the same passage — the human-read assertion this corpus's
   * acceptance criterion asks for. Not derivable, and deliberately not derived:
   * a corpus whose pairs were computed by the matcher under test would agree
   * with the matcher by construction.
   */
  readonly sameBecause: string
  readonly places: Readonly<Record<BuildId, PassagePlace>>
}

/* ------------------------------------------------------------ the prose */

/*
 * One paragraph of Melville, set three ways. The prose is public domain; the
 * MARKUP is what differs, because markup is what a CFI counts.
 */

const LOOMINGS_A = [
  '<h2>CHAPTER 1. Loomings.</h2>',
  /* THE SCRIPT, and only this build has one. A reading-progress widget is a
     real habit of scraped HTML, and it is the shape WI-21.P1 was found on:
     stripping it shifts every later sibling's index by one, so a CFI computed
     against the raw document addresses the paragraph BEFORE the one it found. */
  '<script type="text/javascript">/* a reading-progress widget */</script>',
  '<p>Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.</p>',
  '<p>It is a way I have of driving off the spleen, and regulating the circulation.</p>',
  '<p>"Who ain\'t a slave?" Tell me that.</p>',
].join('\n')

const LOOMINGS_B = [
  '<section epub:type="chapter">',
  '<h2>I</h2>',
  '<p>Call me Ishmael. Some years ago — never mind how long precisely — having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.</p>',
  '<p>It is a way I have of driving off the spleen, and regulating the circulation.</p>',
  '<p>“Who ain’t a slave?” Tell me that.</p>',
  '</section>',
].join('\n')

const LOOMINGS_C = [
  '<div class="chapter">',
  '<h2 class="chapter-title">Loomings</h2>',
  '<p class="first">Call me Ishmael. Some years ago—never mind how long precisely—having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world.</p>',
  '<p>It is a way I have of driving off the spleen, and regulating the circulation.</p>',
  '<p>“Who ain’t a slave?” Tell me that.</p>',
  '</div>',
].join('\n')

/**
 * Enough prose to push the next paragraph past `flatten`'s bound.
 *
 * DERIVED FROM THE BOUND, never a hard-coded length: `DEFAULT_MAX_CHARS` is
 * documented as *"a guess until it is measured against real books"*, and a
 * corpus that hard-codes 20 000 stops covering the hazard the moment the guess
 * is revised — silently, which is the failure mode this whole file exists
 * against.
 */
function filler(prefixWords: string): string {
  const sentence = `${prefixWords} the sea, and the sea alone, keeps its own counsel. `
  const paragraphs: string[] = []
  let length = 0
  while (length < DEFAULT_MAX_CHARS + 2_000) {
    const text = sentence.repeat(12).trim()
    paragraphs.push(`<p>${text}</p>`)
    length += text.length
  }
  return paragraphs.join('\n')
}

/**
 * "the whale" three times over, and a passage past `flatten`'s bound.
 *
 * The first two occurrences sit within reach of the walk and the third does
 * not, which is what keeps the two hazards apart: "the quote alone cannot say
 * which one it is" and "the walk gives up before it gets here" are different
 * failures and would be one passage otherwise.
 *
 * `dash` is the ONE thing that differs between builds here, and it is enough:
 * an unspaced em-dash against a spaced one changes both context windows around
 * the last passage without changing a word of the prose.
 */
const CETOLOGY = (filled: string, dash: string): string =>
  [
    '<h2>Cetology</h2>',
    '<p>To be short, then, the whale is a fish, and the ancients said so.</p>',
    '<p>Yet the whale is no fish at all, and the moderns say otherwise.</p>',
    filled,
    `<p>But the whale, in his own proper form, is a thing to be looked at${dash}and not read about.</p>`,
  ].join('\n')

/* --------------------------------------------------------- the builds */

/**
 * Gutenberg: everything in one file per chapter, a licence line on the title
 * page, straight quotes, an unspaced em-dash, and a stray `<script>`.
 */
const GUTENBERG: CorpusBuild = {
  id: 'gutenberg',
  bookId: 'book:0000000000000000000000006775656e',
  title: 'Moby-Dick; or, The Whale',
  author: 'Herman Melville',
  identifier: 'https://www.gutenberg.org/ebooks/2701',
  contentHash: `${'6775656e'.repeat(8)}`,
  sections: [
    {
      href: 'titlepage.xhtml',
      xhtml: [
        '<h1>Moby-Dick; or, The Whale</h1>',
        '<p>by Herman Melville</p>',
        '<p>This eBook is for the use of anyone anywhere at no cost.</p>',
      ].join('\n'),
    },
    { href: 'chapter-1.xhtml', xhtml: LOOMINGS_A },
    { href: 'chapter-2.xhtml', xhtml: CETOLOGY(filler('Long before'), '—') },
  ],
}

/**
 * Standard Ebooks: an imprint page between the title and the first chapter, so
 * every chapter sits one further down the spine; curly quotes, spaced em-dash,
 * semantic `<section>` wrappers, no scripts.
 */
const STANDARD_EBOOKS: CorpusBuild = {
  id: 'standard-ebooks',
  bookId: 'book:00000000000000000000000073746465',
  title: 'Moby-Dick; or, The Whale',
  author: 'Herman Melville',
  identifier: 'https://standardebooks.org/ebooks/herman-melville/moby-dick',
  contentHash: `${'73746465'.repeat(8)}`,
  sections: [
    {
      href: 'titlepage.xhtml',
      xhtml: ['<h1>Moby-Dick; or, The Whale</h1>', '<p>By Herman Melville</p>'].join('\n'),
    },
    { href: 'imprint.xhtml', xhtml: '<h2>Imprint</h2>\n<p>This ebook is thought to be in the public domain.</p>' },
    { href: 'chapter-1.xhtml', xhtml: LOOMINGS_B },
    { href: 'chapter-2.xhtml', xhtml: CETOLOGY(filler('Long before'), ' — ') },
  ],
}

/**
 * A commercial EPUB: a cover, a title page and a copyright page ahead of the
 * text, class-heavy markup, curly quotes, and an ISBN for its identifier.
 */
const COMMERCIAL: CorpusBuild = {
  id: 'commercial',
  bookId: 'book:0000000000000000000000006d6f6279',
  title: 'Moby-Dick',
  author: 'Herman Melville',
  identifier: 'urn:isbn:9780142437247',
  contentHash: `${'6d6f6279'.repeat(8)}`,
  sections: [
    { href: 'cover.xhtml', xhtml: '<div class="cover"><img alt="Moby-Dick" src="cover.jpg"/></div>' },
    {
      href: 'title.xhtml',
      xhtml: ['<h1>Moby-Dick; or, The Whale</h1>', '<p class="author">Herman Melville</p>'].join('\n'),
    },
    { href: 'copyright.xhtml', xhtml: '<h2>Copyright</h2>\n<p>All rights reserved.</p>' },
    { href: 'chapter-1.xhtml', xhtml: LOOMINGS_C },
    { href: 'chapter-2.xhtml', xhtml: CETOLOGY(filler('Long before'), ' — ') },
  ],
}

export const CORPUS_BUILDS: Readonly<Record<BuildId, CorpusBuild>> = {
  gutenberg: GUTENBERG,
  'standard-ebooks': STANDARD_EBOOKS,
  commercial: COMMERCIAL,
}

/* ---------------------------------------------------- reading the prose */

/**
 * A section's text as the reader would see it — the same rule `flatten` and
 * `markContext` apply between them.
 *
 * SCRIPTS AND STYLES YIELD NOTHING, matching `flatten`'s `SKIPPED_TAGS`: they
 * are never rendered, whatever their style says, so their source must not
 * appear in a context window. Getting this wrong would make the corpus's own
 * labels disagree with the app for exactly the build the script hazard is in.
 */
export function plainText(xhtml: string): string {
  const withoutScripts = xhtml.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gu, ' ')
  const withoutTags = withoutScripts.replace(/<[^>]*>/gu, ' ')
  const decoded = withoutTags
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
  return decoded.replace(/­/gu, '').replace(/\s+/gu, ' ').trim()
}

/**
 * The 32 characters either side of one occurrence of a quote, by
 * `markContext`'s rule — squeeze first, then slice by code point.
 *
 * This is what holds the hand-written table honest: the labels below are typed
 * out by a person, and `markCorpus.test.ts` checks every one of them against
 * this. A label that drifts from the document fails there rather than sending
 * a matcher test down a wrong path.
 */
export function contextOf(
  build: CorpusBuild,
  place: Pick<PassagePlace, 'sectionIndex' | 'quote' | 'occurrence'>,
  chars = 32,
): { readonly prefix: string; readonly suffix: string } | null {
  const section = build.sections[place.sectionIndex]
  if (!section) return null
  const text = plainText(section.xhtml)
  let at = -1
  for (let n = 0; n < place.occurrence; n++) {
    at = text.indexOf(place.quote, at + 1)
    if (at === -1) return null
  }
  const before = Array.from(text.slice(0, at))
  const after = Array.from(text.slice(at + place.quote.length))
  return {
    prefix: before.slice(Math.max(0, before.length - chars)).join(''),
    suffix: after.slice(0, chars).join(''),
  }
}

/**
 * One build as bytes — what the falsifier hashes.
 *
 * A package document and its sections, in spine order. Not a real zip: the
 * question this answers is whether the three builds DIFFER, and two builds that
 * differ here differ in the archive too.
 */
export function buildFile(build: CorpusBuild): string {
  const manifest = build.sections
    .map((section, index) => `    <item id="s${index}" href="${section.href}" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const spine = build.sections.map((_, index) => `    <itemref idref="s${index}"/>`).join('\n')
  const head = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package version="3.0" unique-identifier="uid">',
    '  <metadata>',
    `    <dc:identifier id="uid">${build.identifier}</dc:identifier>`,
    `    <dc:title>${build.title}</dc:title>`,
    `    <dc:creator>${build.author}</dc:creator>`,
    '  </metadata>',
    '  <manifest>',
    manifest,
    '  </manifest>',
    '  <spine>',
    spine,
    '  </spine>',
    '</package>',
  ].join('\n')
  const bodies = build.sections
    .map((section) => `<!-- ${section.href} -->\n<html><body>\n${section.xhtml}\n</body></html>`)
    .join('\n')
  return `${head}\n${bodies}\n`
}

/* -------------------------------------------------------- the passages */

/**
 * The table. One row per hazard, six rows, hand-written.
 *
 * ⚠️ **THE CFIs ARE DERIVED BY HAND FROM THE RENDERED ELEMENT ORDER**, and the
 * derivation is stated here so the next reader can check it rather than trust
 * it. A spine index `n` is the step `/6/(2n+2)`; inside the document, `/4` is
 * the body and each element child is `2k` for the k-th; `/1` is the first text
 * node and `:offset` is a UTF-16 offset into it. `markCorpus.test.ts` checks
 * the spine step and both offsets against the documents above — the two halves
 * a mislabel actually lands in.
 */
export const CORPUS_PASSAGES: readonly CorpusPassage[] = [
  {
    id: 'call-me-ishmael',
    covers: 'spine-index-differs',
    sameBecause:
      'The first sentence of Loomings. It sits at spine index 1, 2 and 3 — Standard ' +
      'Ebooks puts an imprint page ahead of it and the commercial build puts three ' +
      'pages ahead of it — so the SAME passage carries three different section ' +
      'indexes, which is the field `findMark` requires to match before it will even ' +
      'compare CFIs.',
    places: {
      gutenberg: {
        sectionIndex: 1,
        cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:15)',
        quote: 'Call me Ishmael',
        occurrence: 1,
        prefix: 'CHAPTER 1. Loomings. ',
        suffix: '. Some years ago—never mind how ',
      },
      'standard-ebooks': {
        sectionIndex: 2,
        cfi: 'epubcfi(/6/6!/4/2/4,/1:0,/1:15)',
        quote: 'Call me Ishmael',
        occurrence: 1,
        prefix: 'I ',
        suffix: '. Some years ago — never mind ho',
      },
      commercial: {
        sectionIndex: 3,
        cfi: 'epubcfi(/6/8!/4/2/4,/1:0,/1:15)',
        quote: 'Call me Ishmael',
        occurrence: 1,
        prefix: 'Loomings ',
        suffix: '. Some years ago—never mind how ',
      },
    },
  },
  {
    id: 'driving-off-the-spleen',
    covers: 'section-has-script',
    sameBecause:
      "Ishmael's reason for going to sea, in the paragraph after the first. Only the " +
      'Gutenberg build carries a `<script>` in this section, and it sits BEFORE this ' +
      'paragraph — so the raw document counts it as a sibling and the rendered one ' +
      'does not. This is the pair that can catch WI-21.P1 class: a CFI computed ' +
      'against the raw document lands one paragraph early.',
    places: {
      gutenberg: {
        sectionIndex: 1,
        cfi: 'epubcfi(/6/4!/4/6,/1:22,/1:44)',
        quote: 'driving off the spleen',
        occurrence: 1,
        prefix: 'he world. It is a way I have of ',
        suffix: ', and regulating the circulation',
      },
      'standard-ebooks': {
        sectionIndex: 2,
        cfi: 'epubcfi(/6/6!/4/2/6,/1:22,/1:44)',
        quote: 'driving off the spleen',
        occurrence: 1,
        prefix: 'he world. It is a way I have of ',
        suffix: ', and regulating the circulation',
      },
      commercial: {
        sectionIndex: 3,
        cfi: 'epubcfi(/6/8!/4/2/6,/1:22,/1:44)',
        quote: 'driving off the spleen',
        occurrence: 1,
        prefix: 'he world. It is a way I have of ',
        suffix: ', and regulating the circulation',
      },
    },
  },
  {
    id: 'who-aint-a-slave',
    covers: 'typography',
    sameBecause:
      'One line of dialogue, set two ways. Gutenberg uses straight quotes and a ' +
      'straight apostrophe; the other two use curly. The quote STRINGS therefore ' +
      'differ while the passage does not, and an exact-match on the quote would ' +
      'refuse the pair.',
    places: {
      gutenberg: {
        sectionIndex: 1,
        cfi: 'epubcfi(/6/4!/4/8,/1:0,/1:20)',
        quote: '"Who ain\'t a slave?"',
        occurrence: 1,
        prefix: 'and regulating the circulation. ',
        suffix: ' Tell me that.',
      },
      'standard-ebooks': {
        sectionIndex: 2,
        cfi: 'epubcfi(/6/6!/4/2/8,/1:0,/1:20)',
        quote: '“Who ain’t a slave?”',
        occurrence: 1,
        prefix: 'and regulating the circulation. ',
        suffix: ' Tell me that.',
      },
      commercial: {
        sectionIndex: 3,
        cfi: 'epubcfi(/6/8!/4/2/8,/1:0,/1:20)',
        quote: '“Who ain’t a slave?”',
        occurrence: 1,
        prefix: 'and regulating the circulation. ',
        suffix: ' Tell me that.',
      },
    },
  },
  {
    id: 'boilerplate-author',
    covers: 'boilerplate',
    sameBecause:
      "The author's name on the title page — present in all three builds, and the " +
      'text most likely to false-match, because every book by Melville carries it ' +
      'and so does every other page of front matter. The contexts either side are ' +
      'the only thing that separates the three.',
    places: {
      gutenberg: {
        sectionIndex: 0,
        cfi: 'epubcfi(/6/2!/4/4,/1:3,/1:18)',
        quote: 'Herman Melville',
        occurrence: 1,
        prefix: 'Moby-Dick; or, The Whale by ',
        suffix: ' This eBook is for the use of an',
      },
      'standard-ebooks': {
        sectionIndex: 0,
        cfi: 'epubcfi(/6/2!/4/4,/1:3,/1:18)',
        quote: 'Herman Melville',
        occurrence: 1,
        prefix: 'Moby-Dick; or, The Whale By ',
        suffix: '',
      },
      commercial: {
        sectionIndex: 1,
        cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:15)',
        quote: 'Herman Melville',
        occurrence: 1,
        prefix: 'Moby-Dick; or, The Whale ',
        suffix: '',
      },
    },
  },
  {
    id: 'the-whale-second',
    covers: 'occurs-more-than-once',
    sameBecause:
      'The SECOND "the whale" in Cetology. There are three in the section and the ' +
      'quote is nine characters, so the quote alone cannot say which; the prefix ' +
      '("…the ancients said so. Yet ") is what distinguishes it from the first.',
    places: {
      gutenberg: {
        sectionIndex: 2,
        cfi: 'epubcfi(/6/6!/4/6,/1:4,/1:13)',
        quote: 'the whale',
        occurrence: 2,
        prefix: ', and the ancients said so. Yet ',
        suffix: ' is no fish at all, and the mode',
      },
      'standard-ebooks': {
        sectionIndex: 3,
        cfi: 'epubcfi(/6/8!/4/6,/1:4,/1:13)',
        quote: 'the whale',
        occurrence: 2,
        prefix: ', and the ancients said so. Yet ',
        suffix: ' is no fish at all, and the mode',
      },
      commercial: {
        sectionIndex: 4,
        cfi: 'epubcfi(/6/10!/4/6,/1:4,/1:13)',
        quote: 'the whale',
        occurrence: 2,
        prefix: ', and the ancients said so. Yet ',
        suffix: ' is no fish at all, and the mode',
      },
    },
  },
  {
    id: 'looked-at-not-read-about',
    covers: 'past-flatten-bound',
    sameBecause:
      'The last line of Cetology, past 22 800 characters into its section — well ' +
      "beyond `flatten`'s 20 000-character bound, where the walk stops and reports " +
      '`truncatedEnd`. The em-dash after it is unspaced in Gutenberg and spaced in ' +
      'the other two, so the SUFFIX differs while the passage does not.',
    places: {
      gutenberg: {
        sectionIndex: 2,
        cfi: 'epubcfi(/6/6!/4/68,/1:42,/1:65)',
        quote: 'a thing to be looked at',
        occurrence: 1,
        prefix: 'ale, in his own proper form, is ',
        suffix: '—and not read about.',
      },
      'standard-ebooks': {
        sectionIndex: 3,
        cfi: 'epubcfi(/6/8!/4/68,/1:42,/1:65)',
        quote: 'a thing to be looked at',
        occurrence: 1,
        prefix: 'ale, in his own proper form, is ',
        suffix: ' — and not read about.',
      },
      commercial: {
        sectionIndex: 4,
        cfi: 'epubcfi(/6/10!/4/68,/1:42,/1:65)',
        quote: 'a thing to be looked at',
        occurrence: 1,
        prefix: 'ale, in his own proper form, is ',
        suffix: ' — and not read about.',
      },
    },
  },
]

/**
 * The spine step a CFI opens with, or null when it does not look like one.
 *
 * Exported for the corpus's own test: a section index and a spine step are two
 * spellings of one fact, and a table that lets them disagree is a table that
 * can send a matcher test down a path the app never takes.
 */
export function spineStepOf(cfi: string): number | null {
  const match = /^epubcfi\(\/6\/(\d+)/u.exec(cfi)
  return match ? Number(match[1]) : null
}
