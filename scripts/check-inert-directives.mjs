#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm directives:check` — no suppression comment for a tool that never runs.
 *
 * A `// eslint-disable-next-line react-hooks/exhaustive-deps` is a claim: this
 * rule would fire here, someone looked, and the omission is deliberate. Seven
 * of them were in this tree and ESLint has never been a dependency of it — so
 * every one was a claim about a review that no tool had performed, sitting
 * directly above the dependency arrays where a stale closure hides. One of
 * those arrays was genuinely wrong (`state.markTint`, found by hand), which is
 * the cost of the pretence in one line: the comment says the question was
 * asked, and it makes the next reader less likely to ask it.
 *
 * THE FIX IS NOT TO BAN THE COMMENT. It is to keep it honest. A directive is
 * fine the moment the tool that reads it is installed and gated; until then it
 * is decoration that reads as diligence. So this checks the pair: a suppression
 * for a tool this repo does not run is a finding, and the day the tool arrives
 * the finding disappears on its own.
 *
 * The reasons those seven carried are all still in the tree — the prose above
 * each one was the part with the information in it. Only the machine
 * instruction went, because there is no machine.
 */

/** The tree the CLI checks. Exported because only the process entry uses it,
 *  and a test is the one place a wrong root can be seen before it ships. */
export const REPO = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['src', 'scripts']

/**
 * Suppression comments, by the tool that would read them.
 *
 * `package` asks the manifest, not the filesystem: a transitive copy of ESLint
 * under `node_modules` — and there are usually several — is not this repository
 * running ESLint, and treating it as such would make the check pass for the
 * wrong reason on any machine where something else pulled one in.
 *
 * ⚠️ **NO `[^\n]*` ON THE END OF A PATTERN, AND EACH TOOL NAMES ONE PACKAGE
 * RATHER THAN A LIST OF ONE.** Both were here, and neither could ever be wrong:
 * every pattern is asked of a single LINE, so a trailing "and then anything"
 * matches exactly what its absence matches, and `some` over a list of one
 * agrees with `every`. Dead text like that is not free — it is where a mutant
 * no test can kill comes from, which is this file's own subject one level up.
 */
const TOOLS = [
  { name: 'eslint', pattern: /\beslint-(disable|enable)\b/g, package: 'eslint' },
  { name: 'prettier', pattern: /\bprettier-ignore\b/g, package: 'prettier' },
  { name: 'biome', pattern: /\bbiome-ignore\b/g, package: '@biomejs/biome' },
]

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && EXTENSIONS.has(extname(entry.name))) out.push(full)
  }
  return out
}

/** Suppressions under `root` whose tool `root`'s manifest does not declare. */
export function inertDirectives(root, roots = ROOTS) {
  const manifest = JSON.parse(
    readFileSync(
      join(root, 'package.json'),
      // Stryker disable next-line StringLiteral: a read with no encoding answers a Buffer, and `JSON.parse` stringifies one as UTF-8 anyway — so both parse the same manifest and no test can tell them apart
      'utf8',
    ),
  )
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])
  const live = new Set(TOOLS.filter((tool) => declared.has(tool.package)).map((t) => t.name))

  const found = []
  for (const dir of roots) {
    if (!existsSync(join(root, dir))) continue
    for (const file of walk(join(root, dir))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      for (const [at, line] of lines.entries()) {
        for (const tool of TOOLS) {
          if (live.has(tool.name)) continue
          tool.pattern.lastIndex = 0
          if (!tool.pattern.test(line)) continue
          /* This file names every pattern it hunts, so it matches itself and
             its own test. Excluding by path rather than by some cleverer rule
             because the alternative — a marker comment — is the same exemption
             with more moving parts. */
          const rel = relative(root, file).split(sep).join('/')
          if (rel.endsWith('check-inert-directives.mjs') || rel.endsWith('check-inert-directives.test.mjs')) continue
          found.push({ file: rel, line: at + 1, tool: tool.name })
        }
      }
    }
  }
  return { found, live: [...live] }
}

const LINTER_ADVICE =
  '\nA suppression for a tool that never runs is a claim that a rule was\n' +
  'considered and waived, with nothing behind it. Either install and gate\n' +
  'the tool — then the directive is true and this check goes quiet on its\n' +
  'own — or delete the directive and keep the reason as prose.\n'

/**
 * THE SECOND RULE, which is the first one's argument with the tool installed.
 *
 * A `Stryker disable next-line <mutator>` says exactly what the suppressions
 * above say: somebody looked at this mutant and found it unobservable. Here the
 * tool DOES run, so the comment is honest only if Stryker ignores something
 * because of it — and three spellings ignore nothing at all, because Babel
 * attaches no leading comment to the node the author meant:
 *
 *   - above a `} catch {`, which takes no leading comment of its own;
 *   - after a block's last statement — above a closing `}, [deps])`, say —
 *     where it becomes a TRAILING comment of the statement above it;
 *   - between two chained calls, above a `.sort(…)`, where it leads no node.
 *
 * All three read as "somebody checked this one", and the mutant they name comes
 * back a survivor with no explanation beside it — which is worse than no
 * comment, because the next reader believes the question was already asked.
 * Found all over this branch on 2026-09-14, in `core/settings.ts`,
 * `core/presence.ts`, `Marginalia.tsx`, `SelectionTools.tsx` and
 * `DictionaryView.tsx`.
 *
 * ⚠️ **WHAT IGNORES A MUTANT IS NOT DECIDED HERE.** Stryker's own instrumenter
 * is asked, in memory and writing nothing, the way `check-mutants.mjs`'s
 * `mutantsIn` asks it; Stryker's own parser supplies the comments. So the
 * directives checked are the ones Stryker READS, rather than the ones a rule
 * about where a comment attaches would guess at — and a wrong guess about that
 * is the entire defect this rule exists for.
 *
 * Two things fall out of asking it that way rather than scanning lines. Prose
 * that merely mentions the words is not a directive, because Stryker's regex is
 * anchored to the start of the comment's own text; and a directive inside a
 * string is not one, because a string is not a comment.
 */

/**
 * Stryker's own directive regex — verbatim from `directive-bookkeeper.ts` in
 * `@stryker-mutator/instrumenter` 10.0.0, with `d` added. That flag reports
 * where each group matched and changes nothing about what matches.
 *
 * `^\s?` allows ONE space, so the directive has to be the first thing in its
 * comment; and `[a-zA-Z, ]+` is why this file's own prose cannot be read as a
 * directive, since the angle brackets of a placeholder are not in that class.
 */
const DIRECTIVE = /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)(?::(.+)?)?/d

/**
 * The instrumenter's logger, silenced, as in `check-mutants.mjs`. It warns of a
 * directive naming no known mutator — which this rule reports anyway, and by
 * name: a typo'd mutator ignores nothing.
 */
const QUIET = { isDebugEnabled() {}, debug() {}, info() {}, warn() {} }

/**
 * Stryker's instrumenter and the parser it reads files with, resolved through
 * `@stryker-mutator/core`. Same chain and same reason as `check-mutants.mjs`:
 * the instrumenter is core's dependency rather than this repository's, and the
 * copy core loads is the one whose answer means anything.
 *
 * The parser is a file beside it, because the package exports only its index.
 * It is worth reaching for: it decides which Babel plugins a `.ts`, a `.tsx` or
 * an `.mjs` is read with, and that is not a decision to make twice.
 *
 * ⚠️ **ONE URL RELATIVE TO THE INDEX, NOT A PATH JOINED FROM SEGMENTS.** It was
 * `join(dirname(entry), 'parsers', 'index.js')`, and with the file name gone
 * that named a DIRECTORY — which `node` refuses to import and Vitest's resolver
 * quietly completes to its `index.js`. So every test passed with the path
 * broken, and only the CLI would have failed. Relative to the index, a lost
 * path lands on the index itself, which exists and has no parser in it, and
 * that fails the same way under both.
 */
async function strykerTools() {
  const core = createRequire(import.meta.url).resolve('@stryker-mutator/core')
  const entry = createRequire(core).resolve('@stryker-mutator/instrumenter')
  const { Instrumenter } = await import(pathToFileURL(entry).href)
  const parsers = await import(new URL('parsers/index.js', pathToFileURL(entry)).href)
  return { instrumenter: new Instrumenter(QUIET), parse: parsers.createParser({}) }
}

/** Every `Stryker disable` comment, and where its reason sits in the source. */
export function disableDirectives(comments) {
  const found = []
  for (const comment of comments) {
    const match = DIRECTIVE.exec(comment.value)
    if (match === null) continue
    if (match[1] !== 'disable') continue
    /* `comment.start` is the offset of the `//` or the `/*`, two characters
       before the text the regex matched. `from` is the end of the mutator list
       and `to` the end of the match, so the cut covers the reason whether one
       was written, left after a bare colon, or not written at all. */
    const text = match[4]
    found.push({
      line: comment.loc.start.line,
      from: comment.start + 2 + match.indices[3][1],
      to: comment.start + 2 + match.indices[0][1],
      blank: text !== undefined && text.trim() === '',
    })
  }
  return found
}

/** The reason planted on the directive at `at`, which nothing else can carry. */
export function sentinelFor(at) {
  return `inert-directive-probe-${at}`
}

/**
 * `source` with each directive's reason replaced by its own sentinel, so an
 * ignored mutant names WHICH directive ignored it. Matching on the reason's own
 * words would not: twelve directives in this tree share a reason with another
 * in the same file, and a live one would then cover for an inert one beside it.
 *
 * Line numbering survives, because a sentinel carries no newline and the reason
 * it replaces could not have carried one either.
 *
 * ⚠️ **A BLANK REASON IS LEFT EXACTLY AS WRITTEN.** A directive with nothing
 * but spaces after its colon leaves Stryker's own reason the empty string,
 * which is falsy — so it ignores nothing and the mutant runs live. Writing a
 * sentinel over it would make it look honoured. Left alone its sentinel is
 * never seen, which is the true answer.
 */
export function sentinelled(source, directives) {
  let out = source
  for (let at = directives.length - 1; at >= 0; at--) {
    const directive = directives[at]
    if (directive.blank) continue
    out = `${out.slice(0, directive.from)}:${sentinelFor(at)}${out.slice(directive.to)}`
  }
  return out
}

/** What Stryker can be asked about. Its parser reads no `.css`. */
const SOURCE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/** The cheap gate: a file with none of this text carries no directive. */
const MARK = 'Stryker disable'

const INERT = 'a Stryker disable directive that ignores no mutant'

/**
 * EVERY reason Stryker recorded for `file`, not only the ignored mutants'.
 *
 * For a mutant it did not ignore the reason is `undefined`, which no sentinel
 * is — so a sentinel in this set means the directive carrying it ignored
 * something. The filter that used to stand here changed no answer, and so could
 * not be killed; what it hid was that `statusReason` is the whole story.
 */
async function reasonsFor(instrumenter, file, source, directives) {
  const { mutants } = await instrumenter.instrument(
    [{ name: file, mutate: true, content: sentinelled(source, directives) }],
    {
      plugins: null,
      // Stryker disable next-line ArrayDeclaration: no mutator is named "Stryker was here", so excluding it excludes nothing and no directive's answer can differ
      excludedMutations: [],
      ignorers: [],
    },
  )
  return new Set(mutants.map((mutant) => mutant.statusReason))
}

/** Every `Stryker disable` directive under `root` that ignores no mutant. */
export async function inertStrykerDirectives(root) {
  const { instrumenter, parse } = await strykerTools()
  const found = []
  let files = 0
  let checked = 0
  for (const dir of ROOTS) {
    if (!existsSync(join(root, dir))) continue
    for (const file of walk(join(root, dir))) {
      if (!SOURCE.has(extname(file))) continue
      const source = readFileSync(file, 'utf8')
      if (!source.includes(MARK)) continue
      const rel = relative(root, file).split(sep).join('/')
      let directives
      let reasons
      try {
        directives = disableDirectives((await parse(source, file)).root.comments)
        /* A file whose every mention of the words is prose or string content
           has nothing to ask about — and asking costs the whole instrumenting
           of it, which on this tree is the difference between nine seconds and
           thirty. The skip is HERE rather than inside the asking so that the
           counts below can see it: a file that reached them with no directive
           in it would be counted as one that was checked. */
        if (directives.length === 0) continue
        reasons = await reasonsFor(instrumenter, file, source, directives)
      } catch (cause) {
        /* Not a silent pass: a file Stryker cannot read is a file whose every
           directive went unchecked, and saying so is the only way that differs
           from having checked them. */
        found.push({ file: rel, line: 1, why: `Stryker cannot read this file: ${cause.message}` })
        continue
      }
      files += 1
      checked += directives.length
      for (const [at, directive] of directives.entries()) {
        if (reasons.has(sentinelFor(at))) continue
        found.push({ file: rel, line: directive.line, why: INERT })
      }
    }
  }
  return { found, files, checked }
}

const STRYKER_ADVICE =
  '\nA `Stryker disable` that ignores no mutant is a claim that somebody looked\n' +
  'at that mutant and found it unobservable, with nothing behind it — and the\n' +
  'mutant comes back a survivor with no explanation beside it. Three spellings\n' +
  'do this, each because the comment leads no node:\n' +
  '  - above a `} catch {`, which takes no leading comment;\n' +
  "  - after a block's last statement, above a closing `}, [deps])`;\n" +
  '  - between two chained calls, above a `.sort(…)`.\n' +
  'Move it above the statement whose mutant it names, or delete it and keep the\n' +
  'reason as prose.\n'

/**
 * The whole report, in process — every decision is here, so a test can make it
 * rather than read a spawned child's output. Answers the exit code.
 *
 * Both arguments are required, and that is deliberate: a default here would be
 * a decision no test could make differently, and so a mutant of it would be a
 * mutant no test could kill. The entry below states them instead.
 */
export async function main(stdout, root) {
  const { found, live } = inertDirectives(root)
  for (const { file, line, tool } of found) {
    stdout.write(`${file}:${line}  suppresses ${tool}, which this repo does not run\n`)
  }
  stdout.write(
    `check-inert-directives: ${found.length} inert; linters declared: ${live.length > 0 ? live.join(', ') : 'none'}\n`,
  )
  if (found.length > 0) stdout.write(LINTER_ADVICE)

  const stryker = await inertStrykerDirectives(root)
  for (const { file, line, why } of stryker.found) stdout.write(`${file}:${line}  ${why}\n`)
  stdout.write(
    `check-inert-directives: ${stryker.found.length} inert of ${stryker.checked} Stryker directive(s) in ${stryker.files} file(s)\n`,
  )
  if (stryker.found.length > 0) stdout.write(STRYKER_ADVICE)

  if (found.length > 0) return 1
  if (stryker.found.length > 0) return 1
  return 0
}

// Stryker disable next-line all: reached only when node starts this file, and a spawned child never runs the mutant under test — every decision is in `main`, which is measured in-process
if (isProcessEntry(import.meta)) process.exitCode = await main(process.stdout, REPO)
