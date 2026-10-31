import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Capability } from '../kernel'
import { capabilities as android } from './composition.android'
import { capabilities as desktop } from './composition.desktop'
import { capabilities as ios } from './composition.ios'

/**
 * THE RULES OF THE READER'S SWITCHES, held over the real compositions.
 *
 * Each is what makes an off switch honest, and none is a thing `composeCapabilities`
 * could check for itself: it knows a capability is switchable, not whether turning it
 * off would strand an unjournalled write or leave a port open. So they are here,
 * where a new capability's `toggle` meets them on the day it lands.
 *
 * ABSENT IS FINE, because `pnpm verify:without <id>` runs this with that id cut. A
 * rule about `peer` holds trivially in a tree without one; what must not happen is
 * the file failing to load, so it reaches capabilities through the compositions.
 */

const COMPOSITIONS = [
  ['desktop', desktop],
  ['ios', ios],
  ['android', android],
] as const

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const P2P = 'Peer-to-peer'

/** Every composition's capabilities, one row per id. */
const everyCapability = (): readonly Capability[] => [
  ...new Map(COMPOSITIONS.flatMap(([, caps]) => caps.map((cap) => [cap.id, cap] as const))).values(),
]

describe('who may have a switch', () => {
  it.each(COMPOSITIONS)('%s: nothing non-switchable requires a switchable capability', (_name, caps) => {
    /* It would be left out with its requirement: off here would turn off something
       the rules say the reader may not. */
    const byId = new Map(caps.map((cap) => [cap.id, cap] as const))
    const stranded = caps.flatMap((cap) =>
      cap.toggle
        ? []
        : (cap.requires ?? []).filter((need) => byId.get(need)?.toggle).map((need) => `${cap.id} requires ${need}`),
    )
    expect(stranded).toEqual([])
  })

  it('peer has none: everything that talks to another machine stands on it', () => {
    expect(everyCapability().find((cap) => cap.id === 'peer')?.toggle).toBeUndefined()
  })

  /* If `sync` were off the recorder would stay a no-op, and every write would go
     unjournalled (`core/services.ts`). */
  it('sync has none', () => {
    expect(everyCapability().find((cap) => cap.id === 'sync')?.toggle).toBeUndefined()
  })

  /* It binds its port in Rust `setup`, so a switch held in JS would say off over an
     open port. It gets one only with a Rust-read gate, as `p2p.rs` is. */
  it('webhost has none', () => {
    expect(everyCapability().find((cap) => cap.id === 'webhost')?.toggle).toBeUndefined()
  })

  it('a capability has a switch or follows one, never both', () => {
    expect(everyCapability().filter((cap) => cap.toggle && cap.follows).map((cap) => cap.id)).toEqual([])
  })

  it('what a reader reads never says plugin or capability', () => {
    const words = everyCapability().flatMap((cap) => [cap.toggle?.title, cap.toggle?.summary, cap.follows?.title, cap.follows?.switch])
    expect(words.filter((one) => one !== undefined && /plugin|capabilit/i.test(one))).toEqual([])
  })
})

describe('what follows the P2P switch', () => {
  /* `sync` is excused for the reason the P2P contract gives: it also holds the clock
     and the journal, and runs local-only without a port. Everything else that
     requires `peer` is P2P and nothing else, so the reader is told which switch it is. */
  it.each(COMPOSITIONS)('%s: every capability that is only P2P says so', (_name, caps) => {
    const silent = caps
      .filter((cap) => cap.requires?.includes('peer') && cap.id !== 'sync' && cap.follows?.switch !== P2P)
      .map((cap) => cap.id)
    expect(silent).toEqual([])
  })

  it('names the switch as the Devices pane shows it', () => {
    const pane = readFileSync(path.join(ROOT, 'src/capabilities/peer/lib/p2pSwitch.ts'), 'utf8')
    expect(pane).toContain(`P2P_SWITCH_TITLE = '${P2P}'`)
  })
})

/**
 * Every `.setup(…)` body in a Rust source, comments stripped.
 *
 * Balanced on parens from the call, which is enough for the source this is pointed
 * at: a string holding a paren would end a body early, and such a string in a `setup`
 * is itself worth reading. Line and block comments go first, because the rule below
 * reads words and the repo's comments discuss what was done wrong.
 */
function setupBodiesIn(source: string): readonly string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const bodies: string[] = []
  for (let at = text.indexOf('.setup('); at !== -1; at = text.indexOf('.setup(', at + 1)) {
    const open = at + '.setup'.length
    let depth = 0
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1
      if (text[i] === ')' && --depth === 0) {
        bodies.push(text.slice(open + 1, i))
        break
      }
    }
  }
  return bodies
}

/**
 * The calls a crate's `setup` may make: keep a state and say where the data root is.
 *
 * AN ALLOW-LIST, BECAUSE A LIST OF WHAT IS FORBIDDEN CANNOT END. `spawn`, `bind`,
 * `fs::write` and `block_on` are the ones anyone would think of; a new crate's work
 * can be spelled in any other. A call this does not name fails, and whoever adds it
 * reads the reason below.
 */
const SETUP_MAY_CALL = new Set(['default', 'new', 'app_data_dir', 'path', 'set_root', 'manage', 'Ok'])

/** Calls and macros alike: `spawn!(…)` is work too. A closure's own `|app, _api|` is neither. */
const callsIn = (body: string): readonly string[] =>
  [...body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:::<[^>]*>)?\s*!?\s*\(/g)].map((one) => one[1] as string)

/* A named function would hide its body from the reading below, so that fails too. */
const isClosure = (body: string): boolean => /^\s*(?:move\s*)?\|/.test(body)

/**
 * The crates allowed to do work in `setup`, with the reason.
 *
 * Plain Rust work runs before any webview exists, so a JS switch cannot stop it: an
 * "off" would be a promise made over a port or a walk of the disk already under way.
 * So a new crate leaves its work for the first command. `peer` gates its node on a
 * Rust-read P2P switch; `webhost` binds a port today, which is why it has no switch.
 */
const WORKS_IN_SETUP = new Set(['tauri-plugin-peer', 'tauri-plugin-webhost'])

const CRATES = path.join(ROOT, 'src-tauri/crates')

function rustSourcesUnder(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return rustSourcesUnder(full)
    return entry.name.endsWith('.rs') ? [full] : []
  })
}

describe('a crate does no work in Rust setup', () => {
  it('reads a setup body, and sees through its comments', () => {
    const bodies = setupBodiesIn(`
      Builder::new("x")
        // .setup(|a, _| spawn())
        .setup(|app, _api| {
          /* tauri::async_runtime::spawn(async {}) */
          let state = State::default();
          app.manage(state);
          Ok(())
        })
        .build()
    `)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).not.toContain('spawn')
    expect(callsIn(bodies[0] as string)).toEqual(['default', 'manage', 'Ok'])
  })

  /* That the rule can fail: a body doing work names calls outside the allow-list. */
  it.each(['tauri::async_runtime::spawn(async move {})', 'std::fs::read_dir(root)', 'TcpListener::bind(address)', 'rt.block_on(work)', 'tokio::join!(work)'])(
    'would refuse %s',
    (work) => {
      const [body] = setupBodiesIn(`.setup(|app, _api| { ${work}; Ok(()) })`)
      expect(callsIn(body as string).filter((call) => !SETUP_MAY_CALL.has(call))).not.toEqual([])
    },
  )

  it('would refuse a named function, whose body it cannot read', () => {
    const [named] = setupBodiesIn('.setup(does_work)')
    expect(isClosure(named as string)).toBe(false)
    const [closure] = setupBodiesIn('.setup(move |app, _api| Ok(()))')
    expect(isClosure(closure as string)).toBe(true)
  })

  const crates = readdirSync(CRATES).filter((name) => existsSync(path.join(CRATES, name, 'src')))

  it('finds the crates', () => {
    expect(crates).toEqual(expect.arrayContaining([...WORKS_IN_SETUP]))
  })

  it.each(crates.filter((name) => !WORKS_IN_SETUP.has(name)))('%s', (name) => {
    const bodies = rustSourcesUnder(path.join(CRATES, name, 'src')).flatMap((file) => setupBodiesIn(readFileSync(file, 'utf8')))
    expect(bodies.filter((body) => !isClosure(body))).toEqual([])
    expect(bodies.flatMap(callsIn).filter((call) => !SETUP_MAY_CALL.has(call))).toEqual([])
  })
})
