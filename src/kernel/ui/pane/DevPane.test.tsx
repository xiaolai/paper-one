// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDiagnosticLog, type DiagnosticEntry } from '../../core/diagnosticsLog'
import { DevPane } from './DevPane'

/**
 * ⚠️ **RENDERED, NOT READ BACK.** `GlossStrip` carries the argument for this
 * file's existence: a panel whose states are asserted by scanning its source
 * survives `display: none` on the rule that draws them. The Developer panel has
 * four states a reader can land in — not recording, recording with nothing,
 * recording with entries, and filtered to nothing — and three of them look like
 * "empty" unless something puts them on screen and reads the words.
 */

afterEach(cleanup)

const textOf = (el: Element): string => el.textContent ?? ''

/** A log holding `entries`, oldest first, as the real one is written. */
function logOf(entries: readonly Partial<DiagnosticEntry>[]) {
  const log = createDiagnosticLog()
  entries.forEach((entry, index) => {
    log.record({
      at: entry.at ?? 1_000 + index,
      level: entry.level ?? 'info',
      scope: entry.scope ?? 'boot',
      event: entry.event ?? 'started',
      fields: entry.fields ?? {},
    })
  })
  return log
}

describe('when this build records nothing', () => {
  /* THE STATE THAT LOOKS LIKE THE OTHERS AND IS NOT. Recording is decided at
     boot by a FILE, so a reader can turn developer options on and still see an
     empty panel — and "nothing happened" and "nothing is being written down"
     are different problems with different fixes. */
  it('says so, rather than drawing an empty list', () => {
    render(<DevPane recording={false} />)

    expect(textOf(screen.getByText(/not being recorded/i))).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  /* AND IT SAYS HOW. A panel that reports a state without the one action that
     changes it is §07's dead control in prose. */
  it('names the switch that turns them on', () => {
    const { container } = render(<DevPane recording={false} />)

    expect(textOf(container)).toContain('diagnostics.on')
  })
})

describe('when it records but has nothing yet', () => {
  it('is distinguishable from a build that records nothing', () => {
    const { container } = render(<DevPane recording log={logOf([])} />)

    expect(textOf(container)).not.toMatch(/not being recorded/i)
    expect(textOf(container)).toMatch(/reported nothing yet/i)
  })
})

describe('the entries', () => {
  const entries = [
    { at: 1_000, scope: 'boot', event: 'started', level: 'info' as const },
    { at: 2_000, scope: 'sync.push', event: 'push-refused', level: 'warn' as const },
    { at: 3_000, scope: 'inference', event: 'gloss-failed', level: 'error' as const },
  ]

  /* NEWEST FIRST, because a reader opens this panel after something went
     wrong, and what went wrong is the last thing that happened. */
  it('are newest first', () => {
    render(<DevPane recording log={logOf(entries)} />)

    const rows = screen.getAllByRole('listitem').map(textOf)
    expect(rows[0]).toContain('gloss-failed')
    expect(rows[2]).toContain('started')
  })

  it('carry their scope, event and fields', () => {
    render(
      <DevPane
        recording
        log={logOf([{ scope: 'sync', event: 'session-failed', fields: { kind: 'refused' } }])}
      />,
    )

    const row = textOf(screen.getAllByRole('listitem')[0]!)
    expect(row).toContain('sync')
    expect(row).toContain('session-failed')
    expect(row).toContain('refused')
  })

  /* THE LEVEL IS ON THE ENTRY, not in its words — see the stylesheet. Amber
     text would read as the provenance meaning `marks.ts` reserves amber for. */
  it('carry their level as data rather than as prose', () => {
    render(<DevPane recording log={logOf(entries)} />)

    const levels = screen.getAllByRole('listitem').map((row) => row.getAttribute('data-level'))
    expect(levels).toEqual(['error', 'warn', 'info'])
  })

  it('narrow to warnings and then to errors', () => {
    render(<DevPane recording log={logOf(entries)} />)

    fireEvent.click(screen.getByRole('button', { name: 'Warnings' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Errors' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  /* ⚠️ **THE SCOPE MATCH IS A PREFIX**, because the scopes are compound:
     `sync.push` is part of `sync`, and an exact match would hide every child of
     the scope the reader picked — which is the half they are usually after. */
  it('narrow to a scope and its children', () => {
    render(<DevPane recording log={logOf(entries)} />)

    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'sync' } })

    const rows = screen.getAllByRole('listitem').map(textOf)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('push-refused')
  })

  /* A filter that matches nothing is not the same as a run that reported
     nothing, and the panel must not tell the reader the second. */
  it('say when a filter is what emptied the list', () => {
    const { container } = render(<DevPane recording log={logOf([entries[0]!])} />)

    fireEvent.click(screen.getByRole('button', { name: 'Errors' }))

    expect(textOf(container)).toMatch(/No entry matches/i)
    expect(textOf(container)).not.toMatch(/reported nothing yet/i)
  })
})

describe('the window', () => {
  /* SAID, NOT SWALLOWED. The log is bounded by construction, so a long run
     drops its oldest entries — and a reader who cannot see that the window
     moved will read the first line as the beginning of the run. */
  it('reports how much fell off the back', () => {
    const log = createDiagnosticLog({ capacity: 2 })
    for (const event of ['one', 'two', 'three', 'four']) {
      log.record({ at: 1, level: 'info', scope: 'boot', event, fields: {} })
    }
    const { container } = render(<DevPane recording log={log} />)

    expect(textOf(container)).toMatch(/2 older entries have fallen/i)
  })

  it('says nothing about it while the window still holds everything', () => {
    const { container } = render(<DevPane recording log={logOf([{ event: 'one' }])} />)

    expect(textOf(container)).not.toMatch(/fallen/i)
  })
})

describe('the actions', () => {
  it('hand the window to the caller as JSON Lines, which is the file’s format', () => {
    const onCopy = vi.fn()
    const log = logOf([{ scope: 'boot', event: 'started' }])
    render(<DevPane recording log={log} onCopy={onCopy} />)

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))

    expect(onCopy).toHaveBeenCalledWith(log.toJsonl())
    expect(onCopy.mock.calls[0]![0]).toContain('started')
  })

  it('offer no copy where the caller gave nowhere to copy to', () => {
    render(<DevPane recording log={logOf([{ event: 'one' }])} />)

    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
  })

  /* CLEARING EMPTIES WHAT IS DRAWN, not only what is stored. The list is read
     on a nonce rather than a subscription — see the component — so a clear that
     did not bump it would leave the rows on screen over an empty log. */
  it('clear the log and the list together', () => {
    const log = logOf([{ event: 'one' }, { event: 'two' }])
    const { container } = render(<DevPane recording log={log} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    expect(log.entries()).toHaveLength(0)
    expect(textOf(container)).toMatch(/reported nothing yet/i)
  })

  /* ⚠️ **NOTHING MOVES UNDER THE READER.** The log is written from every corner
     of the app including boot, and a panel that re-rendered per entry would be
     unreadable during the very work it is recording. A refresh is asked for. */
  it('do not show a new entry until the reader asks', () => {
    const log = logOf([{ event: 'one' }])
    render(<DevPane recording log={log} />)

    log.record({ at: 9_000, level: 'info', scope: 'boot', event: 'two', fields: {} })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})
