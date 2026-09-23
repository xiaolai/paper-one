import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * WHAT EACH PLATFORM'S BUNDLE CARRIES.
 *
 * ⚠️ **THIS FILE WAS MOSTLY ABOUT THE LOCAL INFERENCE RUNTIME, WHICH IS GONE.**
 * `tauri.conf.json` used to map `../vendor/inference/current/` to `runtime/`
 * for every platform, so an Android build copied 70 MB of macOS shared
 * libraries into the APK — for a platform that cannot load them and did not
 * compose the capability that would use them. The fix was three desktop-only
 * platform configs, because of the merge rule below; the AI features were
 * deleted whole afterwards, and the three configs and the runtime went with
 * them. What is left is the rule those configs were written under, and the one
 * resource every platform still carries.
 *
 * ⚠️ **TAURI DEEP-MERGES `bundle.resources`, SO A PLATFORM FILE CANNOT REMOVE
 * AN ENTRY THE BASE DECLARES.** Measured: setting `resources` in
 * `tauri.android.conf.json` to the notices alone still produced
 * `assets/runtime/` in the built app, because the two maps merged. Anything
 * that is not for every platform therefore has to be declared only in the
 * platform configs that want it, and never in the base.
 */

const conf = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'))

const EVERY_CONF = [
  'tauri.conf.json',
  'tauri.dev.conf.json',
  'tauri.macos.conf.json',
  'tauri.ios.conf.json',
  'tauri.android.conf.json',
]

/**
 * What each config may declare. Adding a line here is a DECISION, and the
 * comment beside it says what the resource is and why it belongs where it is.
 */
const ALLOWED = {
  /* Everyone's, and stated so that "mobile carries no extra resources" cannot
     be achieved by emptying the base. */
  'tauri.conf.json': ['../THIRD-PARTY-NOTICES.md'],
  /* ⚠️ **MLX's METAL SHADERS, macOS ONLY, AND IN THE macOS CONFIG BECAUSE OF
     THE MERGE RULE ABOVE.** The Chinese voice links MLX, which looks for
     `default.metallib` at run time and dies with "Failed to load the default
     metallib" without it — so the app has to carry the bundle SwiftPM builds.
     Declared here and never in the base: a phone build must not carry Metal
     shaders for an engine it does not compile, and a platform file cannot
     remove what the base declares. The path is a BUILD OUTPUT, written by the
     voices crate's `build.rs`, so a `tauri build` that somehow ran before it
     fails on a missing resource rather than producing an app that cannot
     speak. */
  'tauri.macos.conf.json': ['crates/tauri-plugin-voices/swift/QwenKit/.build/release/mlx-swift_Cmlx.bundle'],
}

describe('what the bundle carries', () => {
  /* THE NOTICES ARE EVERYONE'S. Stated so that "mobile carries no extra
     resources" cannot be achieved by emptying the base. */
  it('every platform carries the third-party notices', () => {
    expect(conf('tauri.conf.json').bundle?.resources?.['../THIRD-PARTY-NOTICES.md']).toBe(
      'THIRD-PARTY-NOTICES.md',
    )
  })

  /* THE BASE IS THE ONLY PLACE A RESOURCE MAY BE DECLARED TODAY, because every
     resource in it is one every platform should have. A resource that is not —
     the deleted runtime was the only one there has ever been — belongs in the
     platform configs that want it, and this case is what notices one arriving
     in the base by habit. */
  it('declares nothing it has not been told about, anywhere', () => {
    for (const name of EVERY_CONF) {
      const declared = Object.keys(conf(name).bundle?.resources ?? {})
      expect(declared, `${name} declares a resource this test has not been told about`).toEqual(
        ALLOWED[name] ?? [],
      )
    }
  })

  /* THE OTHER HALF — that the build output those resources produce is
     gitignored — lives in `check-build-artifacts.test.mjs`, which holds every
     build path in the repository rather than this one directory. Asserted
     there and not here, so there is one list to keep. */
})
