import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * WHAT EACH PLATFORM'S BUNDLE CARRIES — and, mostly, what a phone does not.
 *
 * ## The incident
 *
 * `tauri.conf.json` mapped `../vendor/inference/current/` to `runtime/` for
 * every platform. That directory is the LOCAL INFERENCE RUNTIME staged by
 * `scripts/sync-inference-runtime.mjs`: `lemond`, `lemonade`, and llama.cpp's
 * backend for whichever accelerator this machine has — on a Mac, the Metal
 * `.dylib`s.
 *
 * So an Android build copied 70 MB of macOS shared libraries into the APK, for
 * a platform that cannot load them and does not compose the capability that
 * would use them: `composition.android.ts` is `[peer, sync]`, and the Cargo
 * feature that brings `tauri-plugin-inference` is `desktop`, which mobile
 * builds turn off. They also reached a commit, because Tauri's Android template
 * does not ignore `app/src/main/assets/` the way its Apple one ignores
 * `assets/`.
 *
 * ## Why a platform config and not an override
 *
 * ⚠️ **TAURI DEEP-MERGES `bundle.resources`, so a platform file cannot REMOVE
 * an entry the base declares.** Measured: setting `resources` in
 * `tauri.android.conf.json` to the notices alone still produced
 * `assets/runtime/` in the built app, because the two maps merged. The entry
 * therefore has to live only where it belongs — in the three desktop platform
 * configs — and the base carries only what every platform should have.
 *
 * That is three files saying one thing, which is a shape this repo distrusts.
 * The cases below are what holds them together.
 */

const REPO = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_SOURCE = '../vendor/inference/current/'

const conf = (name) => JSON.parse(readFileSync(new URL(`../src-tauri/${name}`, import.meta.url), 'utf8'))

const DESKTOP = ['tauri.macos.conf.json', 'tauri.windows.conf.json', 'tauri.linux.conf.json']
const MOBILE = ['tauri.ios.conf.json', 'tauri.android.conf.json']

describe('the inference runtime is a desktop resource', () => {
  it('is not in the base config, which every platform merges', () => {
    expect(
      Object.keys(conf('tauri.conf.json').bundle?.resources ?? {}),
      'the base config declares the runtime, so a phone would merge it in and could not opt out',
    ).not.toContain(RUNTIME_SOURCE)
  })

  it.each(DESKTOP)('%s stages it', (name) => {
    expect(conf(name).bundle?.resources?.[RUNTIME_SOURCE], `${name} must stage the runtime`).toBe('runtime/')
  })

  /* THE THREE DESKTOP FILES SAY ONE THING, so they are compared to each other
     rather than each to a literal — a fourth desktop platform, or a change to
     where the runtime is staged, then fails here instead of drifting. */
  it('the desktop configs agree with each other', () => {
    const [first, ...rest] = DESKTOP.map((name) => conf(name).bundle?.resources)
    for (const other of rest) expect(other).toEqual(first)
  })

  it.each(MOBILE)('%s does not, at any level', (name) => {
    const resources = conf(name).bundle?.resources ?? {}
    expect(
      Object.keys(resources),
      `${name} names the runtime — and because Tauri MERGES resources, naming it here cannot be undone downstream`,
    ).not.toContain(RUNTIME_SOURCE)
  })

  /* THE NOTICES ARE EVERYONE'S. Stated so that "mobile carries no resources"
     cannot be achieved by emptying the base. */
  it('every platform still carries the third-party notices', () => {
    expect(conf('tauri.conf.json').bundle?.resources?.['../THIRD-PARTY-NOTICES.md']).toBe('THIRD-PARTY-NOTICES.md')
  })

  /* THE OTHER HALF — that the build output those resources produce is
     gitignored — lives in `check-build-artifacts.test.mjs`, which holds every
     build path in the repository rather than this one directory. Asserted
     there and not here, so there is one list to keep. */
})
