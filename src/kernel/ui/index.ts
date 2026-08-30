/**
 * The kernel's UI entry — for COMPOSITION ROOTS ONLY.
 *
 * `src/main.tsx` and `src/app/composition.*.ts` are the only modules outside
 * the kernel allowed to import this file (`.dependency-cruiser.cjs`, rule
 * `composition-root-kernel-entries`); a capability may import
 * `src/kernel/index.ts` and nothing else of the kernel. The split exists
 * because that entry must stay React-free — it is what a capability's
 * declarations are compiled against — and a composition root has to render
 * the reader, which is React.
 *
 * What is here is what a root needs to boot and draw the kernel: `App`, the
 * boot-time storage and shelf helpers `main.tsx` calls before the first
 * render, and the stylesheet — imported as a side effect, so the reader
 * arrives dressed. The fonts stay with `main.tsx`; they are packages, not
 * kernel files.
 */

import './styles/tokens.css'
import './styles/global.css'
/* The vocabulary contributed UI draws with — global class names, handed across
 * the boundary as strings by `core/capabilityUi`. */
import './styles/capability.css'

export { App } from './App'
/* THE NATIVE BOOT SURFACE, re-exported rather than declared here.
 *
 * It moved to `./boot.ts` when the mobile shell arrived: `bootApp.ts` runs the
 * same launch sequence for both native shells, and reaching it through THIS
 * barrel would have pulled `App` — and with it the whole desktop pane tree —
 * into a mobile bundle that renders none of it. A barrel retains everything it
 * names; that is the defect `./browser.ts` already exists for.
 *
 * Re-exported so the desktop root keeps its single door and sees no change,
 * and so the list has ONE home rather than two that can drift apart. */
export * from './boot'
