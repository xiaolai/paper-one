import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * NOTHING BUILT REACHES THE REPOSITORY.
 *
 * ## Why this is a gate and not a habit
 *
 * It has come close three times, each in a different directory, and each time
 * the fix was a line in a `.gitignore` that only covered the case in front of
 * whoever wrote it:
 *
 *   1. `gen/apple/assets/` — the frontend dist copied in for the iOS resources
 *      phase. Caught, ignored, and a comment written there about it.
 *   2. `gen/android/app/src/main/assets/` — the SAME thing on the other
 *      platform, whose Tauri template ships without the equivalent rule. Not
 *      caught: 73 files and 70 MB of macOS `.dylib`s reached a commit and were
 *      one `git push` from being permanent. (They were removed from history
 *      before anything was pushed.)
 *   3. `gen/android/app/src/main/jniLibs/` — compiled Rust per Android ABI,
 *      where the template ignores only files whose name ends in `.so`, and
 *      nothing else in the directory.
 *
 * The first fix did not prevent the second, because a rule in one platform's
 * ignore file cannot know about the other's. This list is the shared place.
 *
 * ## What it checks
 *
 * `git check-ignore` — not a string search of `.gitignore` files. A rule that
 * exists but does not MATCH is the failure mode that matters, and only git can
 * answer whether a path is ignored: the rules are spread across the repository
 * root and two nested template files, with precedence between them.
 *
 * Paths are probed as files that need not exist. `git check-ignore` answers
 * about a PATH, so this stays true on a machine that has never run an Android
 * build — which is exactly where a missing rule would otherwise go unnoticed
 * until it did.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url))

/**
 * Everything a build writes into the working tree, with what writes it.
 *
 * Add a line here in the change that introduces a build step, not after
 * something from it turns up in `git status`.
 */
const BUILT = [
  { path: 'dist/index.html', by: 'pnpm build — the desktop frontend bundle' },
  { path: 'dist-web/index.web.html', by: 'pnpm build:web — the browser client' },
  { path: 'dist-mobile/index.html', by: 'pnpm build:ios / build:android — the phone bundle' },
  { path: 'bin/paper.mjs', by: 'pnpm build:cli' },
  { path: '.types/app.tsbuildinfo', by: 'pnpm typecheck' },
  { path: 'vendor/pdfjs/pdf.worker.mjs', by: 'scripts/sync-pdfjs-assets.mjs' },
  { path: 'vendor/inference/current/lemond', by: 'scripts/sync-inference-runtime.mjs' },
  { path: 'src-tauri/target/debug/paper', by: 'cargo' },
  /* THE TWO ASSET DIRECTORIES, which are the same defect on two platforms —
     the frontend dist and every `bundle.resources` entry, copied in for
     packaging. */
  { path: 'src-tauri/gen/apple/assets/index.html', by: 'tauri ios build — resources phase' },
  { path: 'src-tauri/gen/android/app/src/main/assets/index.html', by: 'tauri android build — asset merge' },
  { path: 'src-tauri/gen/android/app/src/main/assets/runtime/lemond', by: 'tauri android build — bundle resources' },
  /* COMPILED OUTPUT for each mobile platform. */
  { path: 'src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libpaper_lib.so', by: 'cargo, via the NDK' },
  /* ⚠️ **NOT A `.so`, DELIBERATELY.** The Tauri template's own rule is
     `/src/main/jniLibs/` followed by a `.so` glob, so the line above passes
     with or without the directory rule this repo adds — mutation testing
     showed exactly that, removing the directory rule and failing nothing. This
     probe is what pins it: anything else the NDK leaves in that directory is
     compiler output too. */
  { path: 'src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/libpaper_lib.a', by: 'cargo, via the NDK' },
  { path: 'src-tauri/gen/apple/build/arm64/Paper.app/Paper', by: 'xcodebuild' },
  { path: 'src-tauri/gen/apple/Externals/Paper.a', by: 'tauri ios build' },
  /* TOOL STATE that is not output but is equally not authored. */
  { path: 'src-tauri/gen/android/.gradle/file-hashes.bin', by: 'gradle' },
  { path: 'src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk', by: 'gradle' },
  { path: 'src-tauri/gen/apple/xcuserdata/state.xcuserstate', by: 'Xcode' },
  { path: 'src-tauri/gen/apple/Pods/Manifest.lock', by: 'pod install' },
]

/** Whether git would ignore `path`, whether or not it exists. */
function ignored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: REPO })
    return true
  } catch {
    return false
  }
}

describe('build output never reaches the repository', () => {
  /* THE PROBE ITSELF FIRST. If `check-ignore` stopped working — a git that
     does not know `--no-index`, a wrong cwd — every case below would report
     "not ignored" and the suite would fail loudly rather than pass quietly.
     This case is the other direction: a path that MUST NOT be ignored, so a
     probe that answers "yes" to everything is caught too. */
  it('the probe can tell ignored from tracked', () => {
    expect(ignored('src/main.tsx'), 'the probe calls a source file ignored — it is answering nothing').toBe(false)
    expect(ignored('dist/index.html'), 'the probe cannot see an obviously ignored path').toBe(true)
  })

  it.each(BUILT)('$path — written by $by', ({ path }) => {
    expect(ignored(path), `${path} is build output and git does not ignore it`).toBe(true)
  })

  /* AND NOTHING BUILT IS ALREADY TRACKED. Ignoring a path does not untrack a
     file added before the rule existed — which is precisely how the Android
     assets got in and stayed in. */
  it('none of it is tracked despite the rules', () => {
    const tracked = execFileSync('git', ['ls-files', '--', ...BUILT.map((one) => one.path)], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim()
    expect(tracked, 'these are ignored AND tracked — an ignore rule added after the fact').toBe('')
  })
})
