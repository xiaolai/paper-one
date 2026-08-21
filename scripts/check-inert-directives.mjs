#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['src', 'scripts']

/**
 * Suppression comments, by the tool that would read them.
 *
 * `installed` asks the manifest, not the filesystem: a transitive copy of
 * ESLint under `node_modules` — and there are usually several — is not this
 * repository running ESLint, and treating it as such would make the check pass
 * for the wrong reason on any machine where something else pulled one in.
 */
const TOOLS = [
  { name: 'eslint', pattern: /\beslint-(disable|enable)\b[^\n]*/g, packages: ['eslint'] },
  { name: 'prettier', pattern: /\bprettier-ignore\b[^\n]*/g, packages: ['prettier'] },
  { name: 'biome', pattern: /\bbiome-ignore\b[^\n]*/g, packages: ['@biomejs/biome'] },
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
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])
  const live = new Set(
    TOOLS.filter((tool) => tool.packages.some((pkg) => declared.has(pkg))).map((t) => t.name),
  )

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { found, live } = inertDirectives(REPO)
  for (const { file, line, tool } of found) {
    process.stdout.write(`${file}:${line}  suppresses ${tool}, which this repo does not run\n`)
  }
  process.stdout.write(
    `check-inert-directives: ${found.length} inert; linters declared: ${live.length > 0 ? live.join(', ') : 'none'}\n`,
  )
  if (found.length > 0) {
    process.stdout.write(
      '\nA suppression for a tool that never runs is a claim that a rule was\n' +
        'considered and waived, with nothing behind it. Either install and gate\n' +
        'the tool — then the directive is true and this check goes quiet on its\n' +
        'own — or delete the directive and keep the reason as prose.\n',
    )
    process.exit(1)
  }
}
