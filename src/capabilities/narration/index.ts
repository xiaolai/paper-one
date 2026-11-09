import { createElement } from 'react'
import {
  messageOf,
  type Capability,
  type CapabilityContext,
  type Command,
  type CommandContext,
  type Disposable,
  type KernelServices,
  type SettingsStore,
} from '../../kernel'
import { currentControl } from './lib/running'
import { narrationSupported } from './lib/wire'
import { ExportHost } from './ui/ExportHost'
import { ListenControl } from './ui/ListenControl'
import { createReadingStore, type ReadingStore } from './ui/reading'
import { ReadingHost } from './ui/ReadingHost'
import { VoiceSettings } from './ui/VoiceSettings'

/**
 * Reading aloud: Listen in the title bar and the transport that replaces it,
 * the Voice section in Settings, and the open book exported as an audiobook —
 * one `.m4b` with a chapter mark per section, read in the voice the reader
 * listens with.
 *
 * ⚠️ **THE KERNEL'S UNTIL STEP 5.5.** The reading, its settings and its
 * controls crossed together, in one change, because they could not cross
 * apart: the kernel cannot import a capability, a capability's settings are
 * scoped to its own keys, and the reducer that held the voice never saw the
 * store. The settings are carried from `kernel.*` to `narration.*` by the
 * kernel's own import (`carryNarrationSettings`), run on every load, in which a
 * key already written under the new name wins.
 *
 * ⚠️ **THE WINDOW NEVER NAMES A PATH THE PLUGIN OPENS AS GIVEN.** The reader
 * picks the destination in the plugin's own save dialog and the window gets a
 * token; scratch is a run directory the plugin made, and a chapter is an index
 * into it. See `dev-docs/decisions/2026-11-09-narration-boundary.md`.
 *
 * ⚠️ **THE DOWNLOADABLE VOICES ARE USED AND NOT REQUIRED.** Without them the
 * reading is the platform's own voice, Web Speech, and the export has no
 * engine to render a chapter with, so the host answers no control and the
 * palette has no row.
 *
 * ⚠️ **NO `available`, AND IT HAD ONE.** It asked the plugin whether this
 * machine can package a book, which is a question about the export alone: the
 * encoder is macOS's, so a capability gated on it would take Read aloud away
 * from every other desktop. The answer is asked in `start` instead and gates
 * only the export's host.
 *
 * Like every switch it takes effect at the next launch, so an export running
 * when it is turned off goes on, and keeps its stop row, until it ends or is
 * stopped (`dev-docs/decisions/2026-10-31-plugin-boundary.md`, D5). Off means
 * off because its crate opens nothing until a command asks it to
 * (`NarrationState`).
 */

/** What `start` made, until its disposer. */
interface Running {
  readonly services: KernelServices
  /** Narration's own settings, scoped to `narration.*` by the registry. */
  readonly settings: SettingsStore
  /** The reading the host publishes and the controls read. */
  readonly reading: ReadingStore
  /** Whether this machine can package an audiobook — macOS only, the plugin says. */
  readonly exportable: boolean
}

let run: Running | null = null

export const narration: Capability = {
  id: 'narration',
  requires: [],
  toggle: {
    title: 'Read aloud',
    summary:
      'Listen to the open book, in a voice on this device or one you downloaded, and on a Mac export it as an audiobook. Off, Listen, the voice settings and the export are gone, and the audiobooks you made stay where you saved them.',
  },

  settings: [
    {
      id: 'narration:voice',
      title: 'Voice',
      /* After Reading (10) and before the downloadable Voices (14): which voice
       * reads, and how fast, is part of how a book is read, and the packs it
       * may read with come after it. */
      order: 12,
      render: () => run && createElement(VoiceSettings, { store: run.reading, settings: run.settings }),
    },
  ],

  windowHosts: [
    /* THE READING FIRST: the kernel draws window hosts before the shell, so
       the reading is published before the Listen control reads it. */
    {
      id: 'narration:reading',
      render: (context) =>
        run &&
        createElement(ReadingHost, { context, services: run.services, settings: run.settings, store: run.reading }),
    },
    {
      id: 'narration:export',
      render: (context) =>
        run?.exportable
          ? createElement(ExportHost, { context, services: run.services, settings: run.settings })
          : null,
    },
  ],

  readerControls: [
    {
      id: 'narration:listen',
      render: () => run && createElement(ListenControl, { store: run.reading, settings: run.settings }),
    },
  ],

  commands: (ctx: CommandContext): Command[] => {
    const control = currentControl()
    if (!control) return []
    /* A RUNNING EXPORT KEEPS ITS ROW WITHOUT A BOOK, because the row is the only
       way to stop it; a new one needs a book open. */
    if (!control.running && !ctx.hasBook) return []
    return [
      {
        id: 'narration:audiobook',
        label: control.running ? 'Stop exporting the audiobook' : 'Export as audiobook…',
        group: 'Book',
        keywords: 'narrate speech m4b listen chapters read aloud file',
        on: control.running,
        /* THE CONTROL AS IT IS WHEN THE ROW IS CHOSEN, not as it was when the
           palette was built: a press must reach the export running now. */
        run: () => currentControl()?.run(),
      },
    ]
  },

  async start(api: CapabilityContext): Promise<Disposable> {
    /* ⚠️ **AN UNREADABLE ANSWER COSTS THE EXPORT AND NOT THE READING.** A
       plugin that does not say whether it can package is a plugin whose
       packaging nobody should start; but the reading needs nothing from it,
       so it is reported where a failure is looked for and the export is not
       offered. */
    let exportable = false
    try {
      exportable = await narrationSupported()
    } catch (cause) {
      api.diagnostics.error('narration.support-unreadable', { message: messageOf(cause) })
    }
    run = { services: api.services, settings: api.settings, reading: createReadingStore(), exportable }
    return {
      dispose: () => {
        run = null
      },
    }
  },
}
