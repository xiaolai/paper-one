// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  composeCapabilities,
  createKernelServices,
  createSettingsStore,
  defineSetting,
  kernelApi,
  NOOP_DIAGNOSTICS,
  readSwitchedOff,
  scopeSettings,
  type CapabilityContext,
  type Command,
  type CommandContext,
  type Diagnostics,
  type KernelServices,
  type PaneContext,
  type ReaderContext,
  type SettingsStore,
} from '../../kernel'

const seam = vi.hoisted(() => ({ invoke: vi.fn<(command: string) => Promise<unknown>>() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: seam.invoke }))

import { narration } from './index'
import { publishControl } from './lib/running'

/**
 * What this file pins is the CONTRIBUTION: the palette row, the host and the
 * lifetime. The export itself is `useAudiobook.test.tsx`'s subject and the host
 * `ExportHost.test.tsx`'s; neither can see whether the capability offers them.
 */

const ctx: CommandContext = { screen: 'reader', pane: null, hasBook: true, openPane: () => {} }

const row = (commands: Command[]) => commands.find((command) => command.id === 'narration:audiobook')

/** The capability started as the registry starts it, with whatever a case needs to see. */
async function start(
  over: { services?: KernelServices; settings?: SettingsStore; diagnostics?: Diagnostics } = {},
) {
  const api = {
    services: over.services ?? ({} as KernelServices),
    settings: over.settings ?? scopeSettings(createSettingsStore({ storage: null }), 'narration'),
    diagnostics: over.diagnostics ?? NOOP_DIAGNOSTICS,
    onCleanup: () => {},
  } as CapabilityContext
  return narration.start!(api, new AbortController().signal)
}

/** The props of what a contribution drew. */
const drawnProps = (drawn: unknown) => (drawn as { props: Record<string, unknown> }).props

let withdraw: (() => void) | null = null
const offer = (running: boolean, run: () => void = () => {}) => {
  withdraw?.()
  withdraw = publishControl({ running, run })
}

beforeEach(() => seam.invoke.mockReset())
afterEach(() => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  withdraw?.()
  withdraw = null
})

describe('what the app is offered', () => {
  it('is the narration capability, requiring nothing', () => {
    /* ⚠️ It needs the voices' engine, and reaches it through the kernel's
       speech port — not by requiring the voices capability, so a build without
       them composes and simply has no row. */
    expect(narration.id).toBe('narration')
    expect(narration.requires).toEqual([])
  })

  it('has no availability check, because whether a machine can package is the export’s question alone', () => {
    /* ⚠️ The encoder is macOS's, so a capability gated on it would take Read
       aloud away from every other desktop. */
    expect(narration.available).toBeUndefined()
  })

  it('contributes the Voice section, between Reading and the downloadable voices', () => {
    expect(narration.settings?.map(({ id, title, order }) => ({ id, title, order }))).toEqual([
      { id: 'narration:voice', title: 'Voice', order: 12 },
    ])
  })

  it('contributes Listen to the title bar', () => {
    expect(narration.readerControls?.map((control) => control.id)).toEqual(['narration:listen'])
  })

  it('runs the reading ahead of the export, so the reading is published before Listen reads it', () => {
    expect(narration.windowHosts?.map((host) => host.id)).toEqual(['narration:reading', 'narration:export'])
  })

  it('draws nothing until the capability has started, and nothing once it is disposed', async () => {
    const context = {} as ReaderContext
    const pane = {} as PaneContext
    const drawnAll = () => [
      ...narration.windowHosts!.map((host) => host.render(context)),
      ...narration.readerControls!.map((control) => control.render(context)),
      ...narration.settings!.map((section) => section.render(pane)),
    ]
    expect(drawnAll()).toEqual([null, null, null, null])

    const started = await start()
    expect(drawnAll().filter((drawn) => drawn === null), 'outside the app, every part is drawn').toEqual([])

    started.dispose()
    expect(drawnAll()).toEqual([null, null, null, null])
  })

  it('hands every part the same services, settings and reading', async () => {
    const services = {} as KernelServices
    const settings = {} as SettingsStore
    const started = await start({ services, settings })
    const context = {} as ReaderContext
    const [reading, exporting] = narration.windowHosts!.map((host) => drawnProps(host.render(context)))
    const listen = drawnProps(narration.readerControls![0]!.render(context))
    const voice = drawnProps(narration.settings![0]!.render({} as PaneContext))

    expect(reading).toMatchObject({ context, services, settings })
    expect(exporting).toMatchObject({ context, services, settings })
    expect(listen!.settings).toBe(settings)
    expect(voice!.settings).toBe(settings)
    /* ONE store, or Listen and the Voice section would read a reading the host
       never published. */
    expect(reading!.store).toBeDefined()
    expect(listen!.store).toBe(reading!.store)
    expect(voice!.store).toBe(reading!.store)
    started.dispose()
  })

  it('makes a new reading for each start, so a later start reads nothing an earlier one published', async () => {
    const storeNow = () => drawnProps(narration.readerControls![0]!.render({} as ReaderContext))!.store
    const first = await start()
    const before = storeNow()
    first.dispose()
    const second = await start()
    expect(storeNow()).not.toBe(before)
    second.dispose()
  })
})

describe('the export host', () => {
  /* The question itself — and what a reply that is not a boolean means — is
     `narrationSupported`'s, in `lib/wire.test.ts`. */
  const hostOf = (id: string) => narration.windowHosts!.find((host) => host.id === id)!
  const drawn = (id: string) => hostOf(id).render({} as ReaderContext)

  it('is drawn where the plugin says it can package', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    seam.invoke.mockResolvedValueOnce(true)
    const started = await start()
    expect(seam.invoke).toHaveBeenCalledWith('plugin:narration|narration_supported')
    expect(drawn('narration:export')).not.toBeNull()
    started.dispose()
  })

  it('is not drawn where the plugin says it cannot, and the reading still is', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    seam.invoke.mockResolvedValueOnce(false)
    const started = await start()
    expect(drawn('narration:export')).toBeNull()
    expect(drawn('narration:reading')).not.toBeNull()
    started.dispose()
  })

  it('is not drawn where the answer cannot be read, which is reported, and the reading still is', async () => {
    /* ⚠️ An unreadable answer costs the export and not the reading: Read aloud
       needs nothing from the plugin. */
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    seam.invoke.mockResolvedValueOnce('yes')
    const error = vi.fn()
    const started = await start({ diagnostics: { ...NOOP_DIAGNOSTICS, error } })
    expect(error).toHaveBeenCalledWith('narration.support-unreadable', {
      message: 'the narration plugin did not say whether it can package a book',
    })
    expect(drawn('narration:export')).toBeNull()
    expect(drawn('narration:reading')).not.toBeNull()
    started.dispose()
  })

  it('reports nothing where the answer was read', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    seam.invoke.mockResolvedValueOnce(false)
    const error = vi.fn()
    const started = await start({ diagnostics: { ...NOOP_DIAGNOSTICS, error } })
    expect(error).not.toHaveBeenCalled()
    started.dispose()
  })
})

describe('the palette row', () => {
  /**
   * ⚠️ **THE PALETTE IS THE WHOLE OF THE EXPORT'S SURFACE**, so this is the only
   * place the feature can be found at all. The row is absent where the engine
   * is not (a browser, a phone, a build without voices), because a command that
   * would be refused is worse than one that is not offered.
   */
  it('offers the audiobook export only where the engine is and a book is open', () => {
    expect(row(narration.commands!(ctx))).toBeUndefined()

    offer(false)
    expect(row(narration.commands!(ctx))?.label).toBe('Export as audiobook…')

    /* No book, nothing to export — the same rule every other Book row follows. */
    expect(row(narration.commands!({ ...ctx, hasBook: false }))).toBeUndefined()
  })

  it('contributes no rows at all where it offers no export', () => {
    /* Not merely "no export row": the capability has one row to give, so where
       that is withheld the palette gets nothing from it. */
    expect(narration.commands!(ctx)).toEqual([])
    offer(false)
    expect(narration.commands!({ ...ctx, hasBook: false })).toEqual([])
  })

  it('files the export under Book, and can be found by the words a reader would type', () => {
    /* ⚠️ **THE KEYWORDS ARE THE ONLY WAY IN.** A reader looking for it types
       what they want — "audiobook", "m4b", "read aloud" — not the label's own
       words, and the group puts it beside the other things you do to a book. */
    offer(false)
    const found = row(narration.commands!(ctx))
    expect(found?.group).toBe('Book')
    for (const word of ['narrate', 'speech', 'm4b', 'listen', 'chapters', 'read aloud', 'file']) {
      expect(found?.keywords, `a reader typing ${word} would not find it`).toContain(word)
    }
  })

  it('turns the export row into a stop while one is running', () => {
    /* One command, two states: the reader who started it looks in the same place
       to stop it. */
    offer(true)
    const found = row(narration.commands!(ctx))
    expect(found?.label).toBe('Stop exporting the audiobook')
    expect(found?.on).toBe(true)
  })

  it('keeps the stop when the book is closed, because it is the only way to stop', () => {
    offer(true)
    expect(row(narration.commands!({ ...ctx, hasBook: false }))?.label).toBe('Stop exporting the audiobook')
  })

  it('is off while nothing runs', () => {
    offer(false)
    expect(row(narration.commands!(ctx))?.on).toBe(false)
  })

  it('presses the control published when the row is chosen, not the one it was built with', () => {
    const first = vi.fn()
    const second = vi.fn()
    offer(false, first)
    const found = row(narration.commands!(ctx))!
    offer(true, second)
    void found.run()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    withdraw?.()
    withdraw = null
    expect(() => found.run(), 'a press after the host has gone does nothing').not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('its switch', () => {
  const launch = (switchedOff: ReadonlySet<string>) => {
    const services = createKernelServices({ fs: null, storage: null })
    return composeCapabilities([narration], kernelApi(services), new AbortController().signal, { switchedOff }).then(
      (composition) => ({ services, composition }),
    )
  }

  it('words its switch without saying plugin or capability, and says what off does', () => {
    expect(narration.toggle?.title).toBe('Read aloud')
    expect(`${narration.toggle?.title} ${narration.toggle?.summary}`).not.toMatch(/plugin|capability/iu)
    expect(narration.toggle?.summary).toMatch(
      /\bOff, Listen, the voice settings and the export are gone, and the audiobooks you made stay\b/u,
    )
  })

  it('off, offers no row, draws no host, control or section, and does not ask the plugin', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    seam.invoke.mockResolvedValue(true)
    const { composition } = await launch(new Set(['narration']))
    /* A control left over from anything else would otherwise be offered: off
       must mean the capability contributes nothing at all. */
    offer(false)
    expect(composition.commands(ctx)).toEqual([])
    expect(composition.windowHosts).toEqual([])
    expect(composition.readerControls).toEqual([])
    expect(composition.settings).toEqual([])
    expect(seam.invoke).not.toHaveBeenCalled()
    composition.dispose()
  })

  it('on, offers the row through the composition', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    seam.invoke.mockResolvedValue(true)
    const { composition } = await launch(new Set())
    offer(false)
    expect(row(composition.commands(ctx))?.label).toBe('Export as audiobook…')
    expect(composition.windowHosts.map((host) => host.id)).toEqual(['narration:reading', 'narration:export'])
    expect(composition.readerControls.map((control) => control.id)).toEqual(['narration:listen'])
    expect(composition.settings.map((section) => section.id)).toEqual(['narration:voice'])
    composition.dispose()
  })

  it('turned off during an export, leaves that export running and its stop in the palette', async () => {
    /* ⚠️ **A SWITCH TAKES EFFECT AT THE NEXT LAUNCH**, because nothing can take
       one capability down mid-run. So the export the reader started goes on,
       and the stop row stays, because a running export the reader cannot stop
       is the one outcome a switch must not produce. */
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    seam.invoke.mockResolvedValue(true)
    const { services, composition } = await launch(new Set())
    const press = vi.fn()
    offer(true, press)
    /* THE READER'S OFF-LIST, written where Optional features writes it; the
       next launch reads it back through `readSwitchedOff`. */
    const pluginsOff = defineSetting<readonly string[]>('kernel.pluginsOff', [], (raw) =>
      Array.isArray(raw) ? (raw as string[]) : undefined,
    )
    services.settings.set(pluginsOff, ['narration'])
    expect(readSwitchedOff(services.settings).has('narration'), 'switched off for the next launch').toBe(true)

    const stop = row(composition.commands({ ...ctx, hasBook: false }))
    expect(stop?.label).toBe('Stop exporting the audiobook')
    void stop?.run()
    expect(press).toHaveBeenCalledTimes(1)
    composition.dispose()
  })
})

describe('the published control', () => {
  it('is withdrawn only by the host that published it', () => {
    const older = publishControl({ running: false, run: () => {} })
    offer(true)
    older()
    expect(row(narration.commands!(ctx))?.label, 'a stale withdrawal leaves the newer one').toBe(
      'Stop exporting the audiobook',
    )
    withdraw?.()
    withdraw = null
    expect(row(narration.commands!(ctx))).toBeUndefined()
  })
})
