import { defineSetting, messageOf } from '../../../kernel'
import type { Definition, GlossContext, GlossProvider, Setting } from '../../../kernel'
import { readerFailure, type Controller, type ReportFailure } from './controller'
import { ROUTE_FAILURE_KINDS, answeringRoute, isLocalRoute, usableLocal, type RouteStore } from './glossRoute'
import { cancelRequest, errorKind, mintRequestId, type InferencePlugin } from './plugin'

/**
 * The gloss provider — bound by `inference`, and by nothing else.
 *
 * ⚠️ **AN AGENT MAY ANSWER A LOOKUP NOW, AND THIS FILE USED TO SAY IN CAPITALS
 * THAT NO CODE PATH FROM HERE COULD REACH ONE.** That was F8 — an agent "would
 * open a session and start a turn to define one word" — and the owner overturned
 * it on 2026-09-18: Look up is answered by whichever usable route the reader
 * chose, or by the first one Automatic finds, and the local model is an opt-in
 * download rather than the only road. `glossRoute.ts` carries the decision and
 * the order.
 *
 * WHAT STILL HOLDS BY CONSTRUCTION: the provider is handed two of the plugin's
 * commands — `gloss`, and `cancel` to abandon one — and `agentAsk` is not among
 * them. An agent answers a lookup THROUGH `inference_gloss`, with an
 * `agent:` route, in the portable one-shot shape every route answers in — never
 * through the companion's free-form, streamed agent turn. So a lookup is still
 * one request for one definition, whoever writes it.
 * (`GlossProviderOptions.plugin` names the two; it named the whole plugin until
 * a 2026-09-13 audit.)
 *
 * # The cache, and why it is keyed the way it is
 *
 * A reader re-reading a chapter looks the same word up twice, and the second
 * time should cost nothing. The key is THE QUESTION — the exact string the
 * model is sent — because the whole point of the feature is the sense that is
 * on this page: the same word in two sentences is two different glosses and
 * must not share an entry. A key computed beside the request rather than being
 * it is how two different questions came to share one; see `glossQuestion`.
 *
 * It is dropped when the ROUTE changes, because **a gloss is an answer from a
 * particular model and not a fact**. Keeping it across a swap would show a
 * reader Qwen's answer after they chose Claude, or the other way round. A local
 * route's id names its model (`local:<id>`), so a model swap is a route change
 * and is covered by the same comparison.
 *
 * ⚠️ **AND IT IS DROPPED WHEN THE PROMPT CHANGES, FOR THE SAME REASON AND BY A
 * DIFFERENT ROAD.** An answer is from a particular PROMPT too, and the prompt
 * became the reader's to edit (`GLOSS_PROMPT_SETTING`). The key is the
 * QUESTION and the system prompt is a separate argument that is not in it — so
 * without this, editing the prompt served back answers produced under the old
 * one, silently, for as long as the process lived. The language line avoids
 * exactly this by being IN the question, where the key sees it for free (see
 * `glossQuestion`); the prompt cannot take that road, because the question is
 * what the model is sent and putting the instructions in it would send them
 * twice. So both facts travel in `answeredBy` instead, which is what the cache
 * is checked against on the way in.
 *
 * ⚠️ **IT STORES THE MODEL'S OWN TEXT, NOT THE PARSED PAIR**, and `definitionOf`
 * runs on the way OUT of it — on a hit exactly as on a fresh answer. What is
 * remembered is then the one thing that was actually paid for, the reply; a
 * cached answer and a fresh one cannot be told apart by anything downstream,
 * and a change to the parse takes effect on everything already remembered
 * rather than on whatever is asked for next.
 *
 * That text is JSON now (see `definitionOf`), and NO ANSWER IN AN OLD FORMAT —
 * the `pos:` prose, or the list-shaped JSON the portable shape replaced — CAN
 * BE SERVED FROM HERE, checked rather than assumed, on two grounds. The cache
 * is a `Map` inside one provider, in memory, so nothing in it outlives the
 * process; the format is decided by `gloss.rs`, in Rust, so changing it means a
 * rebuild and a relaunch, which empties it. And if an old answer reached
 * `definitionOf` anyway, it fails soft and is drawn whole, which is what the
 * parse does with any reply it cannot read — `reads a reply in the retired pos:
 * shape as all definition` and the retired list shape's case pin that.
 */

/**
 * How many glosses to remember.
 *
 * A chapter's worth of lookups, not a session's: these are short strings, but
 * the sentence is part of every key, so the entries are not free. Oldest out
 * first — a reader moving through a book does not return to chapter one's
 * vocabulary.
 */
const CACHE_LIMIT = 200

/**
 * What the model is told BY DEFAULT. Short, and every line of it is
 * load-bearing.
 *
 * ⚠️ **IT IS A DEFAULT NOW AND IT USED TO BE THE WHOLE ANSWER.** The reader can
 * rewrite it (`GLOSS_PROMPT_SETTING`), which is why this is named for what it
 * is rather than for what it does: a constant called `GLOSS_SYSTEM_PROMPT`
 * beside a setting of the same meaning is two answers to one question, and the
 * one a reader edits is not the one a grep finds first. **Everything below is
 * still MEASURED rather than styled**, and the tests beside it are assertions
 * about this constant precisely so an edit a reader makes cannot quietly repeal
 * what those measurements bought — if the anti-echo line stops working after
 * somebody rewrites their own prompt, that is their prompt, and the default is
 * one press away (see the Look up section).
 *
 * `one or two sentences` bounds it to what a popover can hold. `the sense used
 * here` is the feature: a dictionary gives every sense of *close*, and this
 * gives the one on the page.
 *
 * ⚠️ **"DO NOT REPEAT THE WORD" DID NOT WORK, AND IT WAS MEASURED NOT WORKING.**
 * `DCSCopyTextDefinition`'s doubled headword is the failure this feature was
 * written to avoid, and a model asked to define a word leads with it by
 * default. The prohibition was here from the start and the answers still opened
 * `wharves are the docks…` and `in this context, los wharves son…`; a stronger
 * prohibition fared no better. What worked — seven of seven, on 2026-09-13 — is
 * showing the SHAPE of a good opening instead of naming the bad one
 * (`dev-docs/plans/evidence/wi-17-5-answer-languages.md`). The example uses
 * `wharves`, and answers about other words did not echo it.
 *
 * The language line is WI-17.5's, and it is the SYSTEM prompt's rather than
 * the question's only in its wording: which language to use is a line in the
 * question, where the cache key sees it — see `glossQuestion`.
 *
 * ## ⚠️ THIS PROMPT DESCRIBES NO FORMAT, AND A FORMAT LINE WAS MEASURED BREAKING IT
 *
 * The part of speech — §10's middle line, between the headword and the meaning
 * — was first asked for HERE, as a line: *"Put the part of speech on the first
 * line, written as pos: and the label"*, with a `wharves` example in the shape
 * the opening line had taught. It read as careful, its tests were green, and
 * nobody asked the model. Measured afterwards, 2026-09-18, against the live
 * daemon, 3 terms × 3 runs, the exact question `glossQuestion` builds:
 *
 * | prompt | clean replies |
 * |---|---|
 * | with the `pos:` line | **2 of 9** |
 * | without it — this wording | 9 of 9, and no part of speech |
 * | without it, plus the schema `gloss.rs` sends | **9 of 9, each with a part of speech** |
 *
 * Every failure was drawn in front of a reader: `verb: replacing…` with `verb:`
 * inside the definition (the model used the part of speech AS the marker, so
 * the parse failed soft and kept it), the definition written twice, a dangling
 * `English` under it. **The tests could not see any of it**, because they
 * asserted this constant's TEXT and ran the parse on replies somebody wrote by
 * hand. A test of what a prompt SAYS is not a test of what a model DOES.
 *
 * So the format lives in the request now, as a JSON schema the daemon compiles
 * into a grammar (`gloss.rs`, `response_format`) — which makes a malformed
 * reply impossible where a line of prose only made it less likely — and this
 * prompt went back to the wording measured clean above. Two rules for whoever
 * edits it next:
 *
 * - **Do not describe the shape of the answer here.** The schema owns it —
 *   the part of speech, one meaning per language, in order — and `definitionOf`
 *   reads what the schema makes. A format line is a second, weaker answer to a
 *   question the grammar already settles. (The language line's "each on its
 *   own line" predates the schema and is part of the wording measured clean
 *   WITH it — 27 of 27 across one language and both orders of two — so it
 *   stays: it agrees with the schema rather than competing with it, and
 *   removing it is a wording change like any other, to be measured first.)
 * - **Measure a wording change against the real model before believing it.**
 *   The instrument exists: `live_gloss_answers_in_the_shape_it_asked_for` in
 *   the crate's `commands.rs` sends this prompt (`PAPER_LIVE_SYSTEM_PROMPT`)
 *   through the real request builder to a running daemon and prints every
 *   reply; the lines above it are what "measured" means in this comment.
 */
export const DEFAULT_GLOSS_PROMPT = [
  'You define a word or phrase as it is used in one specific sentence from a book.',
  'Answer in one or two sentences, plain prose, no formatting and no quotation marks.',
  'Give only the sense used here, not every sense the word has.',
  'Start straight with the meaning, the way a dictionary entry does: for wharves, begin with something like "Structures along a shore where ships dock", never "Wharves are" and never "In this sentence".',
  'Do not restate the sentence.',
  'If the sentence does not make the sense clear, say so plainly in one sentence.',
  'Write the answer in the language the request names. When it names two languages, write one sentence in each, the first language first, each on its own line.',
].join(' ')

/**
 * How long the reader's own prompt may be, in CODE POINTS.
 *
 * Counted in code points for `MAX_PART_OF_SPEECH`'s reason: a reader may write
 * their prompt in any script, and a bound in UTF-16 units would hand somebody
 * writing in Chinese a different allowance from somebody writing in English
 * for no reason either of them could see.
 *
 * ⚠️ **WHY 4 000, AND WHY THERE IS A BOUND AT ALL.** The default is 688, so
 * this is room to rewrite it five times over — generous by design, the
 * way `MAX_PART_OF_SPEECH` is, because what it is really there to refuse is not
 * a long prompt but an unbounded one. This string is sent on EVERY lookup,
 * ahead of the question (a title, a sentence, the languages, the term) and the
 * answer, and all three have to fit in the context window of whatever small
 * local model is installed: at roughly four characters to a token 4 000 is
 * about a thousand tokens, which leaves a 4k window three quarters free. Past
 * that a prompt does not fail loudly — the model silently loses the end of the
 * sentence it was asked about, which looks like a bad answer rather than a
 * setting.
 */
export const MAX_GLOSS_PROMPT = 4000

/**
 * The instructions Look up sends, as the reader may rewrite them.
 *
 * ⚠️ **`parse` IS THE TRUST BOUNDARY AND THE EMPTY STRING IS THE CASE IT
 * EXISTS FOR** (`core/ports.ts` says so of every parser). Nothing stops a
 * stored settings file holding a number, a list, or nothing at all — it is
 * JSON on the reader's own disk, hand-editable, restorable from a backup,
 * damaged by a half-written flush — and an EMPTY prompt is the shape that does
 * real harm: the model is handed no instructions, answers whatever a bare
 * question suggests, and every lookup in the app quietly stops being a gloss.
 * A value this refuses becomes the fallback, which is the default above — so
 * the worst case of a damaged file is the app the reader already had.
 *
 * TRIMMED ONLY TO DECIDE, NOT ON THE WAY THROUGH: a prompt that is nothing but
 * whitespace is empty, and one with a stray trailing newline is the reader's
 * text and is stored as they wrote it. `GlossPromptPane` trims what it commits,
 * so the two do not disagree about what is stored.
 *
 * ## What a reader's prompt can and cannot change — since the schema
 *
 * **IT CAN NO LONGER BREAK THE ANSWER'S SHAPE.** While the format was a line
 * of this prompt, the reader was editing the protocol: deleting the `pos:`
 * line lost the part of speech, and rewording it could produce exactly the
 * `verb: …` and doubled-definition replies `DEFAULT_GLOSS_PROMPT` records. The
 * shape is the schema's now (`gloss.rs`), applied to every request whatever
 * this setting says — so no edit here can drop the part of speech, add a stray
 * label line, or merge two languages into one. Measured: the retired `pos:`
 * prompt, sent with the schema, gave 9 of 9 clean answers with the part of
 * speech in its own field. A reader who had saved it keeps a working Look up.
 *
 * **AND A PROMPT THAT ASKS FOR ANOTHER FORMAT IS OVERRIDDEN, SILENTLY TO THE
 * MODEL.** Measured with *"answer as a bulleted list of three senses, then a
 * pos: line"*: no bullets and no `pos:` line in any reply; the grammar wrote
 * the schema's shape each time. That is ACCEPTABLE, and deliberately so: the
 * popup draws one fixed thing — a headword, a part of speech, a meaning per
 * language — and a format it cannot draw would be a broken popup, not a
 * preference honoured. What this setting is FOR is what the answer SAYS — its
 * register, its length, who it is written for — and all of that still reaches
 * the model. Two costs, both named: the reader is told in the pane, because an
 * instruction that does nothing and says nothing is the silent kind of
 * failure; and a prompt asking for MORE (three senses) can spend the gloss's
 * token bound — one reply in three did — which ends in the named refusal "The
 * answer was cut off before it finished", never a fragment in amber.
 */
export const GLOSS_PROMPT_SETTING: Setting<string> = defineSetting(
  // Stryker disable next-line StringLiteral: an empty key makes `defineSetting` throw while this module is imported, so every covering suite fails to load and Stryker's vitest runner reports it Survived (the trap `covers.ts` records) — the key itself is asserted by `names its key, its default and the bounds of its parse`.
  'inference.glossPrompt',
  DEFAULT_GLOSS_PROMPT,
  (raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') return undefined
    /* ⚠️ **THE CHEAP BOUND FIRST, AND IT IS NOT AN OPTIMISATION.** A code point
       is at most two UTF-16 units, so anything longer than twice the bound is
       over it by arithmetic — and finding that out by spreading would allocate
       one array slot per character of a string whose size nothing here chose.
       The one value this file must survive is the one somebody wrote by hand. */
    if (raw.length > MAX_GLOSS_PROMPT * 2) return undefined
    return [...raw].length > MAX_GLOSS_PROMPT ? undefined : raw
  },
)

/**
 * How long a label may be before it stops being a part of speech.
 *
 * COUNTED IN CODE POINTS, because the label is in whatever language the answer
 * is in and a script-neutral bound is the only honest one. Generous by design:
 * `adverb`, `transitive verb`, `名词`, `nom masculin` all fit several times
 * over, and what it is really there to refuse is a sentence the model wrote
 * into the field — the grammar fixes WHERE the label goes, not what it says.
 */
const MAX_PART_OF_SPEECH = 30

/**
 * The answer, read as a definition and its part of speech.
 *
 * THE REPLY IS JSON, in the PORTABLE shape `gloss.rs` sends as a schema to
 * every route — the local model, an endpoint, Claude, Codex:
 *
 * ```json
 * { "definition": { "first":  { "language": "English", "text": "…" },
 *                   "second": { "language": "Simplified Chinese", "text": "…" } },
 *   "partOfSpeech": "noun" }
 * ```
 *
 * `first` is the language asked for first and `second` exists only when two
 * were asked, and the definition is their meanings one to a line — WI-17.5's
 * two-language answer is two lines and `.body` draws them as two
 * (`white-space: pre-line`). `language` is not read: it is there to make the
 * model write the right language into the right slot (the crate's header has
 * the measurements), and the slot's NAME already says which is which.
 * `fixtures/gloss-response-format.json` in the crate is the contract both
 * halves are held to; the test beside this builds a reply from it.
 *
 * ⚠️ **IT WAS A LIST — `definition: [ {…}, {…} ]`, ORDER FOR IDENTITY — AND THE
 * CLOUD ROUTES REFUSED THE SCHEMA THAT SAID SO.** A list whose entries differ
 * needs `prefixItems`, which Claude's strict mode rejects, and pinning each
 * entry's language needs `const`, which OpenAI's rejects without a `type`. Two
 * named slots need neither — only `type`, `enum`, `properties`, `required` and
 * `additionalProperties` — so one schema serves all four routes (the gloss
 * routes contract, §2). The list shape is read by nothing now, deliberately: no
 * route produces it, and a second parser for a shape nothing sends is a second
 * answer waiting to disagree with the first. A reply in it fails soft, below.
 *
 * PURE, AND IT FAILS SOFT IN ONE DIRECTION ONLY: **losing the definition is
 * impossible.** A reply that does not parse as JSON, or whose `definition` has
 * no `first` entry carrying a non-empty `text` string — or has a `second` that
 * carries none — leaves `partOfSpeech` absent and the WHOLE text as the
 * definition: a reader sees braces and quotes around a meaning, which is ugly
 * and complete, rather than an empty amber mark, which `core/gloss.ts` forbids
 * in as many words. The grammar makes that path unreachable from a route that
 * honours the schema; it is here for one that does not, and for a reply cut
 * off mid-object, which `inference_gloss` refuses before it gets this far.
 *
 * ⚠️ **A BAD PART OF SPEECH COSTS ONLY THE PART OF SPEECH.** Missing, not a
 * string, blank, or past `MAX_PART_OF_SPEECH`: the label is dropped and the
 * definition is drawn without it. The `pos:` parse this replaced refused the
 * WHOLE reply for a bad label, and it had to — on a line of prose it could not
 * tell where the label ended and the meaning began. Separate JSON fields have
 * no such ambiguity, so the definition it would have thrown away is exactly
 * right, and throwing it away would mean drawing raw JSON beside the word for a
 * fault in a line of small grey type.
 *
 * Both are trimmed and otherwise left exactly as the model wrote them: the
 * label is drawn as a word, and normalising somebody else's grammatical
 * terminology is a judgement this has no basis for making in a language it
 * cannot read. The ONE exception is an opening that restates `term`, which the
 * popup already draws above the meaning — see `withoutHeadword`.
 */
export function definitionOf(answer: string, term: string): Definition {
  const whole = answer.trim()
  const reply = parsedOrNothing(whole)
  const text = meaningOf(reply, term)
  if (text === null) return { text: whole }
  const partOfSpeech = labelOf(reply)
  return partOfSpeech === null ? { text } : { text, partOfSpeech }
}

/** The reply as a value, or `undefined` when it is not JSON at all. */
function parsedOrNothing(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    /* Not JSON: the fail-soft road in `definitionOf`, not an error to raise.
       NOTHING IS RETURNED FROM HERE, and that is the fix for a survivor: with
       `return undefined` inside this block, a mutant that emptied it returned
       `undefined` all the same, so no test could ever kill it (2026-09-18
       sweep). An empty catch has no mutant to hide. */
  }
  return undefined
}

/** One field of a parsed object, or `undefined` for anything that is not one. */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

/**
 * The meaning lines, `first` then `second`, joined one to a line — or `null`
 * when the reply does not carry a whole one. ALL OR NOTHING: a `second` with no
 * text is a language the reader asked for and would not get, and a definition
 * silently one language short is the case the whole-text fallback exists to
 * avoid. A `second` that is simply ABSENT is one language asked for, which is
 * the schema's own shape for it.
 */
function meaningOf(reply: unknown, term: string): string | null {
  const definition = fieldOf(reply, 'definition')
  const first = lineOf(fieldOf(definition, 'first'), term)
  if (first === null) return null
  const second = fieldOf(definition, 'second')
  if (second === undefined) return first
  const next = lineOf(second, term)
  return next === null ? null : `${first}\n${next}`
}

/** One language's meaning, trimmed and without a restated headword, or `null` when it has none. */
function lineOf(entry: unknown, term: string): string | null {
  const text = fieldOf(entry, 'text')
  if (typeof text !== 'string' || text.trim() === '') return null
  return withoutHeadword(text.trim(), term)
}

/**
 * A CHINESE OPENING THAT NAMES ITS HEADWORD: a short term — up to eight
 * characters, no space or punctuation — then `指`, `意为`, `意思是` or `即` after a
 * comma, or `意味着` / `是指` straight after it. `透明的，指…`, `颠覆意味着…`: the
 * dictionary style the model reaches for in Chinese, measured 2026-09-18.
 */
const HANZI_ECHO = /^[^\s，,。.：:；;（(]{1,8}(?:[，,]\s*(?:指|意为|意思是|即)|意味着|是指)/u

/**
 * A LATIN OPENING THAT NAMES ITS HEADWORD: an optional `to` or article, ONE word,
 * and a connector — `transparent, meaning …`, `To upend means …`, `A quarter is
 * …`. Whether that word IS the headword is `sameWord`'s question, not this
 * pattern's: `This means …` has the shape and names nothing.
 */
const LATIN_ECHO = /^(?:(?:to|a|an|the)\s+)?([\p{L}'-]+)(?:\s*,\s*|\s+)(?:means|meaning|refers\s+to|is)\s+/iu

/**
 * Whether the word an answer opened with is the headword — itself, or the one
 * written as the other's stem (`upend` for `upending`, and the reverse). Three
 * letters at least, so `a` or `is` never counts as anybody's stem.
 */
function sameWord(written: string, term: string): boolean {
  const said = written.toLowerCase()
  const asked = term.trim().toLowerCase()
  return said === asked || (Math.min(said.length, asked.length) >= 3 && (asked.startsWith(said) || said.startsWith(asked)))
}

/**
 * A meaning with the headword it restated taken off the front.
 *
 * ⚠️ **THE POPUP DRAWS THE HEADWORD ALREADY**, so `transparent, meaning clearly
 * visible…` beneath **transparent** says the word twice. Measured 2026-09-18,
 * 3–5 of 27 live replies did it, through lemond and through the bare server
 * alike — always a Chinese answer opening dictionary-style and the English
 * beside it copying the shape. A Chinese example in the prompt did not help
 * (5 of 27), and the prompt is the READER'S to edit, so a fix living there would
 * last until somebody customised it. Here it holds whatever the prompt says —
 * the argument that put the answer's FORMAT in a schema.
 *
 * CONSERVATIVE BY CONSTRUCTION: only the two shapes above are recognised, and
 * everything else — `颠覆，使…` included, which reads like an echo and is not one
 * of them — comes back exactly as written. Never less than something: an answer
 * that is NOTHING but its opening keeps it, for `core/gloss.ts`'s reason. What
 * is left starts with a capital where its script has one, as a meaning does.
 */
export function withoutHeadword(text: string, term: string): string {
  const hanzi = HANZI_ECHO.exec(text)
  const latin = hanzi === null ? LATIN_ECHO.exec(text) : null
  const cut = hanzi !== null ? hanzi[0].length : latin !== null && sameWord(latin[1] ?? '', term) ? latin[0].length : 0
  const rest = text.slice(cut)
  if (cut === 0 || rest.trim() === '') return text
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

/** The part of speech, or `null` when the reply's is not usable as one. */
function labelOf(reply: unknown): string | null {
  const label = fieldOf(reply, 'partOfSpeech')
  if (typeof label !== 'string') return null
  const trimmed = label.trim()
  return trimmed === '' || [...trimmed].length > MAX_PART_OF_SPEECH ? null : trimmed
}

/**
 * Whitespace collapsed to single spaces, and the edges trimmed.
 *
 * APPLIED TO WHAT IS SENT, not to a copy of it kept for the cache — which is
 * the whole of the fix below. A selection differing only in a line break is
 * genuinely the same question, so it should be normalised once, on the way to
 * the model, and the key falls out of that rather than being computed beside it.
 *
 * It also makes `glossQuestion` INJECTIVE, which the key depends on: no field
 * can contain a newline afterwards, so the three-line question cannot be
 * confused with a different one whose title happened to contain
 * `\nSentence: `.
 */
function squeezed(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * The user turn: the sentence, then the term.
 *
 * ⚠️ **THIS IS ALSO THE CACHE KEY**, and that is a correctness property rather
 * than a saving. There used to be a separate `glossKey`, and a key computed
 * beside a request can disagree with it — this one did, in two directions:
 *
 * - **It LOWERCASED the term and the sentence.** The question does not, so
 *   `March` and `march` in one sentence are two different questions with one
 *   cache entry: select the verb after the month and you were served the
 *   month's definition. `Polish`/`polish`, `Bank`/`bank`, and every proper noun
 *   that is also a common word have the same shape.
 * - **It normalised whitespace the request did not.** Two windows differing
 *   only in a line break were one entry AND two different questions, so which
 *   one the model saw depended on which was asked first.
 *
 * A cache is only correct when its key is its request. So there is one string
 * now and it is both: two identical questions share an answer, and nothing else
 * does. That also settles the audit's "two books with the same title collide" —
 * same title, same sentence, same term IS the same question, and serving one
 * answer for it is the cache working rather than a collision. The book's
 * identity is deliberately not in it: the model never sees an id, so an id
 * could only ever split entries that ought to be shared.
 *
 * ⚠️ **THE ANSWER LANGUAGE IS A LINE OF IT, AND THAT IS THE WHOLE OF WI-17.5's
 * CACHE REQUIREMENT.** A key without it would serve every word already looked
 * up back in the old language after the reader switched, silently, for as long
 * as the process lived — the same class of error as serving another model's
 * answer, which the cache already refuses. In the question, the key has it by
 * construction and there is nothing separate to remember. The names are
 * English because the model is told in English; the order is the order asked.
 */
export function glossQuestion(term: string, context: GlossContext): string {
  return [
    `Book: ${squeezed(context.bookTitle)}`,
    `Sentence: ${squeezed(context.sentence)}`,
    `Answer in: ${answerNames(context.answerIn).join(', then ')}`,
    `Define, in this sentence: ${squeezed(term)}`,
  ].join('\n')
}

/**
 * The names the model is told to answer in, in order — for the question's
 * `Answer in:` line AND for the schema, which gives each its own entry.
 *
 * ⚠️ **ONE DERIVATION FOR BOTH, AND THAT IS THE POINT OF IT.** The question
 * names the languages in prose; the schema (`gloss.rs`) names them again as the
 * `language` of each entry, and that is what makes the right language land in
 * the right slot. Two spellings of one list are how a question asking for
 * `English, then Simplified Chinese` came to be answered under a schema built
 * from something else — so there is one, and the cache key, which is the
 * question, covers the schema by construction.
 *
 * ONE OR TWO, BY THE TYPE, kept from `AnswerLanguages` rather than widened to
 * an array: the plugin's command takes exactly `language` and an optional
 * `secondLanguage`, so no third name has anywhere to go.
 */
function answerNames(answerIn: GlossContext['answerIn']): readonly [string] | readonly [string, string] {
  const [first, second] = answerIn
  return second === undefined ? [squeezed(first.name)] : [squeezed(first.name), squeezed(second.name)]
}

export interface GlossProviderOptions {
  /** The two commands a gloss uses, and no others — see the header on `agentAsk`. */
  readonly plugin: Pick<InferencePlugin, 'gloss' | 'cancel'>
  readonly controller: Controller
  /**
   * The system prompt for the next lookup — the reader's, or the default.
   *
   * A GETTER, resolved per call, for the reason `circle/lib/covers.ts` takes
   * `capBytes` as one: the value lives in the settings store, the store belongs
   * to the capability, and a provider handed the STRING would serve whatever
   * was stored when the app started for the rest of the session. It is the same
   * per-call reading `available` and `installAt` already do of the runtime, and
   * for the same reason — a reader who changes something in Settings while the
   * pane is open must not have to restart.
   */
  readonly prompt: () => string
  /**
   * The route the reader chose for Look up, or `AUTOMATIC` (`''`) — a GETTER,
   * for `prompt`'s reason: `GLOSS_ROUTE_SETTING` lives in the settings store,
   * and a choice made in Settings answers the very next lookup.
   */
  readonly route: () => string
  /**
   * The last probe, for every route that is not the local model — see
   * `RouteStore` on why it is held rather than asked per lookup. REFRESHED from
   * here only after a lookup fails in a way that says it was wrong
   * (`ROUTE_FAILURE_KINDS`).
   */
  readonly routes: Pick<RouteStore, 'getSnapshot' | 'refresh'>
  /** Told when a cancel fails for a reason that is not the expected race. */
  readonly report?: ReportFailure | undefined
  /**
   * The settings section where the reader chooses what answers — `inference:gloss`,
   * handed in by the capability that declares it, so the id is written once.
   */
  readonly installAt: string
}

export interface BoundGlossProvider extends GlossProvider {
  /**
   * How many entries are held. For a test and a diagnostic.
   *
   * ⚠️ **`clearCache()` STOOD BESIDE THIS AND NOTHING CALLED IT.** Its comment
   * said "drop the cache — the model changed", which is a job `gloss` does for
   * itself against `cachedFor` on the way in; the method was a second way to do
   * it that no composition root, no teardown and no pane ever reached, kept
   * alive by one test asserting that it worked. A public method with one test
   * and no caller is not a spare handle, it is a second answer waiting to
   * disagree with the first.
   */
  cacheSize(): number
}

/**
 * WHAT AN ANSWER IN THE CACHE WAS PRODUCED BY — the route and the prompt, as
 * one string, which is the whole of what the key cannot say for itself.
 *
 * THE ROUTE, NOT THE MODEL, since any route may answer: a reader who switches
 * from the local model to Claude must not be served the local model's answers
 * to words they looked up before. A local route's id carries its model
 * (`local:<id>`), so a model swap changes this too.
 *
 * LENGTH-PREFIXED, so it is INJECTIVE, which is the only property it has to
 * have. Concatenated plain, a route called `a` under a prompt beginning `bc`
 * and a route called `ab` under a prompt beginning `c` produce one token — two
 * genuinely different pairs sharing one cache, which is the failure this
 * function exists to prevent, arriving by the back door. The prefix says
 * exactly where the route ends, so no two pairs can spell the same token.
 * (`glossQuestion` keeps the same property by a different means, and says so.)
 */
function answeredBy(route: string, prompt: string): string {
  return `${route.length}:${route}${prompt}`
}

export function createGlossProvider({
  plugin,
  controller,
  prompt: promptOf,
  route: chosenRoute,
  routes,
  report: reportTo,
  installAt,
}: GlossProviderOptions): BoundGlossProvider {
  /* A Map, for insertion order: JavaScript's Map iterates oldest-first, which
   * is the eviction order this wants and costs no bookkeeping. */
  const cache = new Map<string, string>()
  /* What everything in the cache was produced by — see `answeredBy`. Null
     while the cache is empty and nothing has been asked yet. */
  let cachedFor: string | null = null

  /* ⚠️ **A REPORTER THAT CANNOT REPLACE WHAT IT REPORTS.** It is called from two
   * places that cannot survive it throwing: the lookup's rejection handler,
   * where the throw BECAME the rejection — the reader was told the reporter's
   * error instead of the runtime's — and `cancelRequest`'s, which nothing
   * awaits, where it escaped as an unhandled rejection. `controller.ts` and the
   * companion's `provider.ts` each guard theirs for the same reason (2026-09-13
   * audit). */
  const report: ReportFailure = (event, fields) => {
    try {
      reportTo?.(event, fields)
    } catch (thrown) {
      console.error('inference gloss: the failure reporter itself threw', thrown, 'while reporting', event)
    }
  }

  /* ONE READING OF "WHICH ROUTE ANSWERS", for `available`, `warm` and `gloss` —
     three questions about one decision, and three spellings of it are how two
     of them came to disagree before (`available` said yes over a runtime
     `installAt` called absent; 2026-09-13 audit). Read per call: the choice is
     a setting, the local model is the controller's live state, and the rest is
     the last probe, each of which can change while a pane is open. */
  const answering = (): string | null =>
    answeringRoute(chosenRoute(), usableLocal(controller.getSnapshot(), controller.textModel()), routes.getSnapshot().routes ?? [])

  /* ⚠️ **NOT YET PROBED IS NOT "NOTHING CAN ANSWER".** The probe that knows
     about endpoints and agents runs at capability start and takes a second or
     two — it spawns the agent CLIs — and until it lands `routes` is `null`. Read
     as empty, a reader with only Claude, Codex or an endpoint set up was told
     "Look up needs something to answer with" for the first moments of every
     session. This repository's rule for a list that has not loaded is the one
     `Voice.canSay` states for an empty voice list: absent is UNKNOWN, and
     unknown allows the press — a false yes costs one wait, a false no costs the
     feature. */
  const unprobed = (): boolean => routes.getSnapshot().routes === null

  return {
    /* SOME ROUTE CAN ANSWER — the reader's choice, or failing that the first
     * Automatic finds. Resolved per call rather than captured: a reader who
     * installs a model, adds an endpoint or signs in while the pane is open
     * must get a working Look up without a restart.
     *
     * ⚠️ **A MODEL ON DISK IS STILL NOT ENOUGH.** With the runtime absent the
     * local model is no route at all (`usableLocal`), so this does not draw a
     * live control whose every press fails at the launch (2026-09-13 audit). */
    get available(): boolean {
      return answering() !== null || unprobed()
    },

    /**
     * THE LOOK UP SECTION, ALWAYS — where the reader chooses what answers.
     *
     * ⚠️ **THIS WAS THE LOCAL MODELS SECTION, AND ONLY WHILE A RUNTIME WAS
     * THERE TO INSTALL INTO** — WI-20.21: with the runtime absent, "Install one"
     * took a 2.5 GB download into nothing, and every lookup then failed with
     * "The runtime is not installed". That rule was right for a feature the
     * local model alone could serve. It is not one now: with no runtime at all,
     * an endpoint or a signed-in Claude or Codex can still answer, so there is
     * always something to do in Settings → Look up, and the section says what.
     * The local model is a choice there, and an opt-in one — the owner's
     * decision of 2026-09-18 — not the road every reader is sent down.
     *
     * STILL A FIELD OF THE PROVIDER and not a constant the kernel knows: a
     * build that did not compose `inference` keeps the port's `NO_GLOSS`
     * default, where it is `null` because there is nowhere at all. See
     * `GlossProvider.installAt`.
     */
    get installAt(): string | null {
      return installAt
    },

    /**
     * Start the runtime now, so the first lookup does not.
     *
     * ⚠️ **THE COST IT REMOVES IS PAID ONCE PER SESSION AND FELT AS THE FEATURE
     * BEING SLOW.** `gloss` below races `controller.start()` against the
     * reader's abort precisely because that start "can take seconds" — a
     * process bound, accelerators probed, a model loaded. Every lookup after it
     * is quick, because the daemon is shared. So the reader's experience is one
     * slow lookup and then a fast feature, and the slow one is the first
     * impression.
     *
     * NOTHING IS AWAITED AND NOTHING IS REPORTED. A warm that fails leaves the
     * state exactly as it was — not started — and the next real `gloss` takes
     * the same road it always did and reports its own failure in the reader's
     * words. Reporting here as well would put a runtime error in front of
     * somebody who has only selected a word, which is the opposite of the point.
     * `controller.start()` is documented as resolving rather than rejecting, and
     * the `catch` is here anyway: this is the one caller that has no one to tell.
     *
     * ONLY WHEN THE LOCAL MODEL WOULD ANSWER. With nothing installed there is
     * nothing to start; with an endpoint or an agent answering, the daemon is
     * not what the lookup waits for, and starting one would spend a reader's
     * memory and battery on a 2.5 GB model they chose not to use — the local
     * model is opt-in, and selecting a word is not opting in.
     */
    warm(): void {
      const route = answering()
      if (route === null || !isLocalRoute(route)) return
      void controller.start().catch(() => {})
    },

    async gloss(term: string, context: GlossContext, signal: AbortSignal): Promise<Definition> {
      /* ONE READING, used for the cache, the launch and the request alike — a
         route read twice could be two routes, one deciding what was remembered
         and the other what was asked. */
      let route = answering()
      /* PRESSED BEFORE THE FIRST PROBE LANDED — `available` allowed it (see
         `unprobed`). Wait for a probe rather than refusing, then decide. */
      if (route === null && unprobed()) {
        await routes.refresh()
        signal.throwIfAborted()
        route = answering()
      }
      if (route === null) {
        /* THE READER CAN MEET THIS NOW, so it is a sentence for them: a probe
           that came back with nothing usable after the press was allowed. */
        throw new Error('Nothing is set up to answer Look up yet. Choose what answers in Settings → Look up.')
      }
      /* RESOLVED PER CALL, exactly as the route above is, and for the same
         reason — see `GlossProviderOptions.prompt`. Read ONCE and used for both
         the cache decision and the request, so there is no second reading that
         could disagree with the one the model was actually sent: that is the
         defect `glossQuestion` records about the old separate `glossKey`, and
         it has the same shape here. */
      const system = promptOf()
      const producedBy = answeredBy(route, system)
      /* THE ROUTE OR THE PROMPT CHANGED. Everything remembered was another
       * route's or another prompt's answer, and a gloss is not a fact. */
      if (cachedFor !== producedBy) {
        cache.clear()
        cachedFor = producedBy
      }

      /* Cancelled is cancelled, cached or not: a lookup the reader abandoned
         used to succeed from the cache and reject from the model, so what
         `useGloss` saw depended on whether the word had been asked before. */
      signal.throwIfAborted()
      /* THE REQUEST IS THE KEY — see `glossQuestion`. Built once and used for
       * both, so there is no second expression that could normalise
       * differently from the one that reaches the model. */
      const question = glossQuestion(term, context)
      const hit = cache.get(question)
      /* PARSED ON THE WAY OUT, so a remembered answer and a fresh one are the
         same answer — see the header on what the cache holds. */
      if (hit !== undefined) return definitionOf(hit, term)

      /* THE READINESS WAIT RACES THE ABORT. A cold start can take seconds —
       * the daemon binds, probes accelerators, loads a model — and a reader
       * who selected a word and moved on would otherwise be held for the full
       * startup before their abort was noticed. Found by audit. */
      /* ⚠️ THE LISTENER IS NAMED AND REMOVED, and it used to be neither. An
       * anonymous `() => resolve('aborted')` was attached with `{ once: true }`
       * — which fires once, but is only REMOVED by firing. When
       * `ensureReady()` won the race, as it does on every ordinary lookup, the
       * listener stayed attached to the caller's signal for its whole life.
       * `useGloss` mints a fresh `AbortController` per ask so the signal dies
       * quickly and the leak is bounded there; a caller that reuses one
       * accumulates a listener per lookup. Found by audit. */
      /* ⚠️ **`start()`, NOT `ensureReady()` — AND THE DIFFERENCE IS WHAT THE
       * READER IS TOLD.** The boolean collapsed every way a launch can fail
       * into one, so the line below said "The runtime is not running" about a
       * runtime that was never INSTALLED, while the controller one call away
       * had already computed that exact sentence from the plugin's `kind` and
       * had nowhere to put it. The cause now arrives here and goes through the
       * same `readerFailure` the plugin's own rejections do (2026-09-13 audit,
       * round 2). The controller reports it; this only speaks. */
      let wake!: (launch: null) => void
      const woken = new Promise<null>((resolve) => {
        wake = resolve
      })
      const onAbort = (): void => wake(null)
      /* ATTACHED BEFORE THE LAUNCH IS ASKED FOR, so an abort that `start()`
         itself sets off — it runs synchronously up to its first await — is
         heard like any other, with no second test for a signal that was
         already aborted when the wait began. */
      signal.addEventListener('abort', onAbort)
      let launch: { readonly cause: unknown } | null
      try {
        /* ⚠️ **AN EMPTY RACE NEVER SETTLES, AND THAT IS NOT A KILL THIS GATE CAN
           READ.** `Promise.race([])` is specified to stay pending for ever, so
           the mutant that empties this list makes `gloss` hang rather than
           answer. The covering tests DO detect it — they hang with it — but a
           hang reaches Stryker as a wall-clock timeout, and `settledVerdict`
           re-runs those precisely because load produces them too. It repeats,
           because it is not load, and a repeat is "whether a test kills it is
           unknown". Stryker's HIT LIMIT is what makes an infinite loop a
           deterministic detection; an infinitely PENDING promise executes no
           instructions, so it never reaches one.
           Verified by hand rather than assumed: column 37 of the line below is
           this array, the mutator is `ArrayDeclaration`, and it is the only
           array on the line, so this directive covers that mutant and no
           other. */
        // Stryker disable next-line ArrayDeclaration: emptying this list leaves `Promise.race([])`, which never settles, so the mutant is detected only as a hang — a wall-clock timeout this gate refuses to read as a kill, and one no re-run can resolve because it is not load
        launch = await Promise.race([
          /* CARRIED, NOT THROWN. A rejection would win the race outright and
             talk about a runtime the reader no longer needs — the abort below
             has to be able to win a tie.

             ⚠️ **AND NO LAUNCH AT ALL FOR A ROUTE THAT DOES NOT RUN HERE.** An
             endpoint or an agent answers without the local daemon, and starting
             it anyway would make the 2.5 GB opt-in the price of every other
             route — the same argument `inferencePort.agentAsk` makes for not
             starting it. Such a route still passes through this wait, already
             settled, so an abort landing now is heard the same way. */
          (isLocalRoute(route) ? controller.start() : Promise.resolve()).then(
            () => null,
            (cause: unknown) => ({ cause }),
          ),
          woken,
        ])
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      /* ⚠️ **THE SIGNAL SAYS WHETHER THE READER LEFT, NOT WHICH SIDE WON.** An
         abort landing as the launch settled leaves the launch's answer in hand
         and the reader gone. This read `ready === 'aborted' || signal.aborted`:
         two readings of one fact, the first never true without the second, so
         the label decided nothing the signal did not (2026-09-14, mutation
         sweep). The race now only WAKES the wait. */
      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      if (launch !== null) throw readerFailure(launch.cause, signal)

      const requestId = mintRequestId('gloss')
      /* One cancel, one place — see `cancelRequest`. This and
       * `inferencePort`'s `withCancel` both swallowed every failure, and
       * fixing one copy is how the other stayed broken. */
      const abort = (): void => cancelRequest(plugin, requestId, report)
      /* No `{ once: true }`: the `finally` below removes it however the call
         ends, and a signal aborts once, so the option could change nothing. */
      signal.addEventListener('abort', abort)
      try {
        const answer = (
          await plugin
            .gloss(requestId, route, system, question, answerNames(context.answerIn))
            .catch((cause: unknown) => {
              /* ⚠️ **THE READER READS THIS, AND THEY USED TO READ NOTHING.**
               *
               * A rejection from the plugin is `{ kind, message }` — a plain
               * object, serialised by the crate's `error.rs`, NOT an `Error`.
               * `useGloss` turns a rejection into the reason `LookUpFace` draws with
               * `error instanceof Error ? error.message : 'No reason was
               * given.'`, so every plugin-side failure took the second branch:
               * the runtime not installed, not started, stopped, unreachable,
               * a model that would not resolve, a request already in flight —
               * all of them reached the reader as **No reason was given.**
               *
               * `detailFor` is the map from `kind` to a sentence in §11's
               * voice, and it has existed since WI-15.4. The gloss path could
               * not use it: `useGloss` is the KERNEL's and `detailFor` is this
               * capability's, and the kernel imports nothing from a
               * capability. So the translation belongs HERE, on the far side
               * of the port, which is the only place that has both.
               *
               * It mattered less when Dictionary.app sat behind a failed
               * gloss. Nothing sits behind it now.
               *
               * ⚠️ **ONLY THE PLUGIN'S OWN REJECTIONS CARRY A `kind`**, and the
               * three branches below are three different failures that an
               * audit found collapsed into one. `detailFor` maps only a
               * `kind`; everything else needs handling here, and the case
               * this whole translation was written for was in the half that
               * did not have any.
               *
               * ⚠️ **A BARE STRING WAS STILL REACHING THE READER AS NOTHING.**
               * Tauri rejects an unknown command with a plain STRING, not an
               * `Error` — `Command inference_gloss not found` — and the first
               * version of this rethrew any no-`kind` cause untouched, so
               * `useGloss`'s `error instanceof Error` was false and the reader
               * got **No reason was given.** exactly as before. That is the
               * failure this fix names in its own commit message, and the test
               * missed it by constructing an `Error`, which is the one shape
               * the real boundary never produces. A non-`Error` cause is
               * wrapped, preserving its text; a real `Error` is passed through
               * with its own message intact.
               *
               * ⚠️ **THE BRANCHES THEMSELVES ARE `readerFailure` NOW**, beside
               * `detailFor` where the sentences are. The companion's `failure`
               * was written as this catch "branch for branch" and nothing held
               * it to that: its last branch was `String(cause)`, so the same
               * rejection object told a reader looking up a word what happened
               * and a reader asking a question `[object Object]` (2026-09-13
               * audit, round 2). What stays here is the REPORT, because the two
               * disagree about it on purpose — see `readerFailure`.
               */
              const kind = errorKind(cause)

              /* ⚠️ **THE MAINTAINER'S HALF, WHICH DID NOT EXIST.** Everything
               * below decides what the READER is told, and every branch of it
               * throws away the only text that says what actually happened.
               * `RuntimeHttp` is the case that proves it: the variant carries a
               * status precisely so somebody can act on it — `error.rs` says
               * "deliberately carries a status and a route" — and it renders as
               * `the inference runtime answered 404 for /api/v1/chat/completions`.
               * `detailFor` maps it to "The runtime refused the request", which
               * is the right sentence for a reader and names neither the status
               * nor the route.
               *
               * So a failing gloss left NOTHING anywhere: not the status, not
               * the route, not the model. `controller.ts`'s `ReportFailure`
               * records the same lesson from the prefix bug — "the message this
               * reports is the maintainer's half, which is the sentence that
               * would have ended the search in a minute" — and the gloss path
               * simply had no such hook until now.
               *
               * Reported for every failure but the reader's OWN abort — a
               * cancellation nobody asked for is worth seeing in a log; one the
               * reader made by moving on is every selection change, and a
               * log full of those buries the failures. */
              if (!(kind === 'cancelled' && signal.aborted)) {
                report('inference.gloss-failed', { kind, route, message: messageOf(cause) })
              }

              /* ⚠️ **A HELD PROBE THAT WAS WRONG IS ASKED AGAIN, ONCE, NOW.** The
               * route was chosen from the last probe, and these kinds say that
               * probe no longer holds — an agent signed out since, a key the
               * keychain will not give up, a route the crate itself calls
               * unusable. Left alone, every later word would be sent the same
               * way and fail the same way; asked again, Automatic moves on to a
               * route that can answer. Unawaited and never rejecting: the reader
               * is owed THIS failure now, not a wait for child processes. */
              if (ROUTE_FAILURE_KINDS.has(kind)) void routes.refresh()

              /* THE READER'S OWN ABORT is passed through as itself, and only
               * when it really was one; everything else becomes the sentence
               * for its `kind`, or a readable `Error` when it has none. All
               * four branches are `readerFailure`. */
              throw readerFailure(cause, signal)
            })
        ).trim()
        /* An empty answer is NOT cached and NOT returned as a definition: an
         * empty amber mark beside a word reads as "this word means nothing". */
        if (answer === '') throw new Error('The model returned nothing')
        /* ⚠️ **ONLY IF THE CACHE IS STILL THIS LOOKUP'S.** Two lookups can be in
         * flight across a route change: A starts under route A, B starts under
         * B and clears the cache on the way in, then A lands and wrote its
         * answer into a cache now labelled B — so the next lookup of A's word
         * served A's answer under B's label. That is the precise thing
         * `cachedFor` exists to prevent, one await too early. The answer is
         * still RETURNED to the caller who asked for it; it is only not
         * remembered for a route that did not produce it. Found by audit.
         *
         * ⚠️ **AND A PROMPT CHANGE OPENS THE SAME WINDOW**, which is why this
         * compares the whole token rather than the route: the reader can commit
         * an edit in Settings while a lookup is in flight, and an answer written
         * back after it would be the old prompt's answer sitting in a cache
         * labelled with the new one — invisible, and for the life of the
         * process. One comparison covers both because one token carries both. */
        if (cachedFor === producedBy) {
          cache.set(question, answer)
        }
        /* OLDEST OUT FIRST, until the cache is back at its limit: a Map visits
           keys in insertion order, and deleting the key being visited is safe.
           A `while` stood here with an `undefined` guard that could never fire —
           the loop only ran while the map held more than the limit. */
        for (const oldest of cache.keys()) {
          if (cache.size <= CACHE_LIMIT) break
          cache.delete(oldest)
        }
        /* ⚠️ **CANCELLED IS CANCELLED AT THE END TOO, AND IT ONLY WAS AT THE
         * START.** The check on the way in exists because "a lookup the reader
         * abandoned used to succeed from the cache and reject from the model";
         * an abort landing while the plugin call SETTLED had the same shape
         * from the other side — the provider resolved, and only `useGloss`
         * dropping the answer hid it. A port that rejects on abort must do so
         * whenever the abort happened. Found by audit.
         *
         * AFTER the cache write, deliberately: the answer is a correct one for
         * this question and was already paid for, so the reader's next lookup
         * of the same word should still be free. What must not happen is
         * RESOLVING a call the caller cancelled. */
        signal.throwIfAborted()
        /* THE SAME READING A CACHE HIT GETS, on the same text. The emptiness
           check is on the RAW reply a few lines up and stays there:
           `definitionOf` only ever hands back text it was given, so nothing
           here can turn a non-empty reply into an empty definition. */
        return definitionOf(answer, term)
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },

    cacheSize: () => cache.size,
  }
}
