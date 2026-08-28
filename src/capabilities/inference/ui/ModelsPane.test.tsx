// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeState } from '../lib/controller'
import type { ModelRow } from '../lib/plugin'
import { ModelsPane } from './ModelsPane'
import type { ModelsModel, ModelsSnapshot } from './modelsModel'

/**
 * The Local models section, mounted — for the one decision the pure model
 * cannot show: what a row DRAWS when a model cannot be installed.
 *
 * WI-20.21. With the runtime absent the pane offered Install on every row,
 * the download landed, and nothing could run it. The rule is the routes
 * pane's: a row that cannot act shows the reason in its value slot and no
 * control, and the section says once why nothing is offered.
 */

const QWEN: ModelRow = {
  id: 'qwen',
  label: 'Qwen3-4B',
  modality: 'text',
  license: 'Apache-2.0',
  bytes: 2_497_281_120,
  installed: false,
}

function snapshotWith(runtime: RuntimeState, models: readonly ModelRow[] = [QWEN]): ModelsSnapshot {
  return {
    runtime,
    models,
    installing: null,
    failure: null,
    keepLoaded: false,
    modelsDir: null,
    residentBytes: null,
    voiceTest: 'idle',
  }
}

/** A model whose snapshot the test sets; every verb is a no-op. */
function fakeModel(snapshot: ModelsSnapshot): ModelsModel {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: async () => {},
    install: async () => true,
    cancelInstall: () => {},
    uninstall: async () => true,
    setKeepLoaded: () => {},
    testVoice: async () => {},
    stopVoice: () => {},
    dispose: () => {},
  }
}

afterEach(cleanup)

describe('the Local models pane', () => {
  it('offers Install when there is a runtime to install into', () => {
    render(<ModelsPane model={fakeModel(snapshotWith({ kind: 'installed' }))} />)
    const install = screen.getByRole('button', { name: 'Install' })
    expect(install.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('Runtime not installed')).toBeNull()
  })

  it('offers no Install with the runtime absent, and says why instead', () => {
    render(<ModelsPane model={fakeModel(snapshotWith({ kind: 'absent', reason: 'not staged' }))} />)
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    /* The row's value slot carries the reason, as an unusable route's does. */
    expect(screen.getByText('Runtime not installed')).toBeTruthy()
    /* And the section says it once, in the reader's words. */
    expect(screen.getByText(/nothing is offered until it is/i)).toBeTruthy()
  })

  /* A file on disk can still be removed; only the download is pointless. */
  it('still offers Remove for a model that is on disk', () => {
    render(
      <ModelsPane model={fakeModel(snapshotWith({ kind: 'absent', reason: 'not staged' }, [{ ...QWEN, installed: true }]))} />,
    )
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
  })
})
