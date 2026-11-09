import { createElement } from 'react'
import type { Capability, CapabilityContext, Command, CommandContext, Disposable, KernelServices } from '../../kernel'
import { currentControl } from './lib/running'
import { narrationSupported } from './lib/wire'
import { ExportHost } from './ui/ExportHost'

/**
 * The open book, exported as an audiobook — one `.m4b` with a chapter mark per
 * section, read in the voice the reader listens with.
 *
 * ⚠️ **THE WINDOW NEVER NAMES A PATH THE PLUGIN OPENS AS GIVEN.** The reader
 * picks the destination in the plugin's own save dialog and the window gets a
 * token; scratch is a run directory the plugin made, and a chapter is an index
 * into it. See `dev-docs/decisions/2026-11-09-narration-boundary.md`.
 *
 * ⚠️ **IT NEEDS THE DOWNLOADABLE VOICES AND DOES NOT REQUIRE THEM.** Every
 * chapter is rendered by the voices' engine, so without one there is nothing to
 * offer, and the host answers no control — but a build without voices still
 * composes with this, and simply has no row.
 *
 * ⚠️ **ITS OWN SWITCH, BESIDE THE VOICES'.** A reader who keeps the voices
 * for reading aloud may not want the export, so this switch takes away only the
 * row. Off means off because its crate opens nothing until a command asks it to
 * (`NarrationState`). Like every switch it takes effect at the next launch, so
 * an export running when it is turned off goes on, and keeps its stop row,
 * until it ends or is stopped (`dev-docs/decisions/2026-10-31-plugin-boundary.md`, D5).
 */

/** The kernel's services, from `start` until its disposer. */
let services: KernelServices | null = null

export const narration: Capability = {
  id: 'narration',
  requires: [],
  toggle: {
    title: 'Audiobook export',
    summary:
      'Make an audiobook of the open book, read in the voice you listen with. Off, the command is gone, and the audiobooks you made stay where you saved them.',
  },

  /* THE PLUGIN SAYS WHETHER IT CAN PACKAGE HERE — see `narrationSupported`. */
  available: () => narrationSupported(),

  windowHosts: [
    {
      id: 'narration:export',
      render: (context) => services && createElement(ExportHost, { context, services }),
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

  start(api: CapabilityContext): Disposable {
    services = api.services
    return {
      dispose: () => {
        services = null
      },
    }
  },
}
