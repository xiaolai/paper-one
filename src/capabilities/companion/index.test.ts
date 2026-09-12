import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { companion } from './index'
/* Through the kernel's public entry, which is the only door a capability may
   use — `kernel-public-entry-only`, and the boundary gate caught the direct
   import of `core/uiTypes` immediately. */
import { UNFINISHED_PANE_IDS } from '../../kernel'

/**
 * What this capability may do at LAUNCH.
 *
 * ⚠️ **IT PROBED ON EVERY START, FOR A PANEL NOBODY CAN OPEN.** `start` ran
 * `routes.refresh()` so "the answer EXISTS before the panel's first render",
 * arguing that WI-15.10's refusal of a probe on a timer did not apply because
 * this is "the single question the Companion panel asks the moment it opens".
 *
 * The panel cannot be opened. `companion` is in `UNFINISHED_PANE_IDS`, so
 * `paneFits` refuses it unless the reader has found ⌘⌃⌥D — and `probe.rs`
 * spawns up to four short-lived child processes, with five-second timeouts,
 * every time. That is precisely the cost WI-15.10 refused, paid by every reader
 * at every launch, behind a pane that is not merely shut but unreachable.
 *
 * Asserted over the SOURCE because the probe leaves no trace a test can hold:
 * it goes out through the inference port to a Tauri command that does not exist
 * here, so a harness would be measuring its own stub. What would actually
 * regress is the call coming back, and that is what this reads.
 */
const SOURCE = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
  /* Comments stripped, or the paragraph explaining the removal counts as the
     thing it explains. */
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')

describe('what the companion does at launch', () => {
  it('is an unfinished panel, which is the premise of the rule below', () => {
    /* NON-VACUOUS: if this ever ships, the rule stops applying and this case is
       the one that says so rather than a silent pass. */
    expect(UNFINISHED_PANE_IDS as readonly string[]).toContain('companion')
  })

  it('probes nothing — the panel and the settings section each ask when they mount', () => {
    expect(SOURCE).not.toMatch(/routes\s*\.\s*refresh\s*\(/u)
    /* Nor any other spawn-bearing call on the way in. `probe` is the one that
       costs child processes; `ensureReady` starts a daemon. */
    expect(SOURCE).not.toMatch(/\.\s*probe\s*\(/u)
    expect(SOURCE).not.toMatch(/ensureReady\s*\(/u)
  })

  it('still registers the capability it is for', () => {
    /* So the two assertions above cannot pass by the capability having been
       gutted. */
    expect(companion.id).toBe('companion')
    expect(typeof companion.start).toBe('function')
    expect(companion.settings?.length ?? 0).toBeGreaterThan(0)
  })
})
