import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createFsProbe, parseManifest, validateManifest } from '../lib/architecture.mjs'
import { bundleSummary, compositionFile, decideBundle, formatFinding, platformFromTauriEnv } from '../lib/compositions.mjs'

/**
 * The Vite side of WI-5.9: one plugin that (1) resolves
 * `virtual:paper-composition` to this build's platform composition and
 * (2) asserts, inside the build, that the emitted bundle contains exactly
 * that platform's capabilities and nothing from another platform's.
 *
 * (1) is a `resolveId` that maps the specifier to a real file —
 * `src/app/composition.<platform>.ts` — so the file goes through the
 * ordinary pipeline under its own id, and Rollup's graph holds one
 * composition and only the capabilities it imports. The other two are never
 * asked for. Nothing filters at runtime.
 *
 * (2) is a `generateBundle` hook: every chunk's `moduleIds` is judged by
 * `decideBundle` (scripts/lib/compositions.mjs) against the manifest, and a
 * finding is `this.error(...)`, which fails the build with the module named.
 * It runs INSIDE the build, not as a script that could be skipped: a green
 * `vite build` is the assertion having passed. On success it prints one
 * line — `assert-bundle: <platform>: <n> capability modules from {ids}` —
 * so the log shows what was asserted, not only that something was.
 *
 * The platform comes from `TAURI_ENV_PLATFORM` (the Tauri CLI sets it for
 * the frontend build: `darwin`/`windows`/`linux`, `ios`, `android`), read
 * once when the config is evaluated. `pnpm build:ios` sets it by hand.
 */

export const VIRTUAL_ID = 'virtual:paper-composition'
export const PLUGIN_NAME = 'paper:composition'
export const MANIFEST_NAME = 'capabilities.manifest.json'

/** The build's platform: an explicit `platform`, else the environment. */
export function selectPlatform(env = process.env, explicit) {
  return explicit ?? platformFromTauriEnv(env.TAURI_ENV_PLATFORM)
}

/**
 * The manifest under `root`, parsed and validated. Throws when it is not
 * both: the bundle is judged against it, and a build judged against a
 * manifest nobody validated is not an assertion.
 */
export function loadManifest(root) {
  const file = path.join(root, MANIFEST_NAME)
  let text
  try {
    // Stryker disable next-line StringLiteral: without an encoding this is a Buffer, which `parseManifest` hands to `JSON.parse`, and `JSON.parse` reads a Buffer as its UTF-8 text — the same text `'utf8'` decodes, so no manifest parses differently
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    // Stryker disable next-line OptionalChaining: `readFileSync` throws only Error objects, so `cause` is never nullish and `?.` reads exactly what `.` does
    throw new Error(`${PLUGIN_NAME}: cannot read ${file}: ${cause?.code ?? cause?.message}`, { cause })
  }
  const parsed = parseManifest(text)
  const findings = parsed.findings.length > 0 ? parsed.findings : validateManifest(parsed.manifest, createFsProbe(root))
  if (findings.length > 0) {
    const lines = findings.map((f) => `  ${f.code} ${f.path === '' ? '(root)' : f.path}: ${f.message}`)
    throw new Error(`${PLUGIN_NAME}: ${MANIFEST_NAME} is invalid (${findings.length} findings; see pnpm architecture:check):\n${lines.join('\n')}`)
  }
  return parsed.manifest
}

/** Every module id in every chunk of a Rollup output bundle, deduplicated. */
export function bundleModuleIds(bundle) {
  const ids = new Set()
  for (const output of Object.values(bundle)) {
    // Stryker disable next-line ConditionalExpression: a Rollup asset carries neither `moduleIds` nor `modules`, so reading one instead of skipping it adds no id
    if (output.type !== 'chunk') continue
    for (const id of output.moduleIds ?? Object.keys(output.modules ?? {})) ids.add(id)
  }
  return [...ids]
}

/** The capability that may read aloud, and the globals it reads aloud through:
 *  `speechSynthesis`, and the `SpeechSynthesis…` interfaces (utterance, voice,
 *  event), which no module outside it has a reason to name. */
export const WEB_SPEECH_OWNER = 'narration'
export const WEB_SPEECH = /speechSynthesis/i

/**
 * WEB SPEECH ONLY WHERE NARRATION IS COMPOSED: the ids of the modules whose
 * rendered code names the Web Speech API, in a bundle for a platform the
 * manifest does not compose narration on, or on every platform when it has no
 * narration entry. Empty where narration is composed.
 *
 * `decideBundle` judges a module by where it lives, so it holds only code
 * that lives in its capability. Until step 5.5 read aloud lived in the kernel,
 * whose modules are legal in every bundle, and two of them, the voice choice
 * and the engine voice, shipped to the web and to phones with every finding
 * clean. They live in narration now, where that rule refuses them. This holds
 * the other half: code that reads aloud, wherever it is written. Only a
 * module's code says that, so this reads the code. Logic that merely concerns
 * voices names no API and passes here; keeping it in narration is what holds
 * it. A module Rollup rendered nothing of has `code: null`, and is skipped. An
 * asset has no `modules`.
 *
 * ⚠️ **NOTHING READ IS A REFUSAL, NOT A PASS.** A bundle whose module maps are
 * empty, or hold only `null` code, names no API only because no code was looked
 * at; that throws, and the build fails, rather than reporting a clean bundle.
 */
export function webSpeechOutsideNarration(platform, bundle, manifest) {
  const owner = manifest.capabilities.find((entry) => entry.id === WEB_SPEECH_OWNER)
  if (owner !== undefined && owner.platforms.includes(platform)) return []
  const found = []
  let read = false
  for (const output of Object.values(bundle)) {
    for (const [id, { code }] of Object.entries(output.modules ?? {})) {
      if (typeof code !== 'string') continue
      read = true
      if (WEB_SPEECH.test(code)) found.push(id)
    }
  }
  if (!read) {
    throw new Error(`assert-bundle: the ${platform} bundle has no rendered module code, so whether it names the Web Speech API was never read`)
  }
  return found
}

/** `root` and its realpath, distinct — a symlinked working directory (macOS
 *  `/tmp`) makes Rollup name modules by the real path while the configured
 *  root keeps the link. */
export function bundleRoots(root) {
  const roots = [root]
  try {
    const real = realpathSync(root)
    if (real !== root) roots.push(real)
  } catch {
    /* an unreadable root has no modules under it either */
  }
  return roots
}

/**
 * The plugin. `options.platform` overrides the environment (tests);
 * `options.env` is the environment to read (defaults to `process.env`);
 * `options.log` receives the summary line (defaults to `console.log`).
 *
 * @returns {import('vite').Plugin}
 */
export function paperComposition(options = {}) {
  const platform = selectPlatform(options.env ?? process.env, options.platform)
  const log = options.log ?? ((line) => console.log(line))
  let root = process.cwd()
  let target = path.resolve(root, compositionFile(platform))
  return {
    name: PLUGIN_NAME,
    // Before `vite:resolve`, which would otherwise try the specifier as a
    // file and fail before this hook is asked.
    enforce: 'pre',
    configResolved(config) {
      root = config.root
      target = path.resolve(root, compositionFile(platform))
      // Said for a BUILD only. Vitest and `vitest list --json` (which
      // `pnpm test:projects` parses) resolve this config too, once per
      // project, and a line on stdout there is noise at best and broken JSON
      // at worst; the dev server resolves the same file silently.
      if (config.command === 'build') {
        log(`${PLUGIN_NAME}: TAURI_ENV_PLATFORM=${JSON.stringify((options.env ?? process.env).TAURI_ENV_PLATFORM ?? '')} → ${platform} → ${compositionFile(platform)}`)
      }
    },
    resolveId(source) {
      return source === VIRTUAL_ID ? target : null
    },
    generateBundle(_outputOptions, bundle) {
      const manifest = loadManifest(root)
      const ids = bundleModuleIds(bundle)

      /* NO TAURI IN A BROWSER BUNDLE, and this is the assertion rather than a
       * habit of writing careful imports.
       *
       * The web build is served to somebody else's phone. `@tauri-apps` code
       * there is dead at best, and at worst it is `appStorage.ts` silently
       * falling back to `localStorage` while the reader believes their marks
       * are on the shelf. It arrives TRANSITIVELY — one import of
       * `./kernel/ui` pulls five modules that reach the Tauri API — so a rule
       * about which files may import what would not catch it. What catches it
       * is looking at the bundle.
       *
       * Verified once by hand on the first web build (0 references). This is
       * what keeps it at zero. */
      if (platform === 'web') {
        const tauri = ids.filter((id) => id.includes('@tauri-apps') || id.includes('tauri-apps/api'))
        if (tauri.length > 0) {
          this.error(
            `assert-bundle: the web bundle reaches ${tauri.length} Tauri module(s), which do not exist in a browser:\n  ` +
              tauri.slice(0, 10).join('\n  '),
          )
        }
      }

      const decision = decideBundle(platform, ids, manifest, bundleRoots(root))
      if (!decision.ok) {
        const lines = decision.findings.map(formatFinding)
        this.error(`assert-bundle: the ${platform} bundle is not the manifest's ${platform} set (${lines.length} findings):\n  ${lines.join('\n  ')}`)
      }

      const speech = webSpeechOutsideNarration(platform, bundle, manifest)
      if (speech.length > 0) {
        this.error(
          `assert-bundle: the ${platform} bundle names the Web Speech API in ${speech.length} module(s), and the manifest does not compose ${WEB_SPEECH_OWNER} on ${platform}:\n  ` +
            speech.join('\n  '),
        )
      }
      log(bundleSummary(platform, decision))
    },
  }
}
