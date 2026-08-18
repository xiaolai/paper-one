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
    text = readFileSync(file, 'utf8')
  } catch (cause) {
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
    if (output.type !== 'chunk') continue
    for (const id of output.moduleIds ?? Object.keys(output.modules ?? {})) ids.add(id)
  }
  return [...ids]
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
      const decision = decideBundle(platform, bundleModuleIds(bundle), manifest, bundleRoots(root))
      if (!decision.ok) {
        const lines = decision.findings.map(formatFinding)
        this.error(`assert-bundle: the ${platform} bundle is not the manifest's ${platform} set (${lines.length} findings):\n  ${lines.join('\n  ')}`)
      }
      log(bundleSummary(platform, decision))
    },
  }
}
