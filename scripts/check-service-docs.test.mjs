import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SERVICE_GRANTS, SERVICE_NOUNS, SERVICE_TABLE } from '../src/kernel/core/serviceTable.ts'
import { GENERATED_BY, renderServiceTable } from './lib/service-docs.mjs'
import { DOC, committedServiceDocs, currentServiceDocs } from './write-service-docs.mjs'

/**
 * `docs/service-table.md` is the descriptors, and cannot be anything else
 * (phase 11, WI-11.8).
 *
 * The gate `check-compositions` is for the manifest, this is for the
 * reference: generate from the source of truth, compare with what is
 * committed, and fail with the command that repairs it. A documentation table
 * kept in step by hand is the most reliably stale of a phase's four lists,
 * because nothing fails when it drifts — which is exactly why this exists
 * rather than a convention.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('the committed reference', () => {
  it('is exactly what the descriptors render', () => {
    const generated = renderServiceTable({ table: SERVICE_TABLE, nouns: SERVICE_NOUNS, grants: SERVICE_GRANTS })
    const committed = committedServiceDocs()
    expect(committed).not.toBeNull()
    /* Compared line by line, so a failure names WHICH line moved rather than
     * dumping four hundred of them at a reader. */
    expect((committed ?? '').split('\n')).toEqual(generated.split('\n'))
  })

  it('says it is generated, on its first line', () => {
    expect((committedServiceDocs() ?? '').split('\n')[0]).toBe(GENERATED_BY)
  })

  it('names every service, every grant and every noun', () => {
    const text = committedServiceDocs() ?? ''
    for (const one of SERVICE_TABLE) {
      expect(text).toContain(`\`${one.name}\``)
      expect(text).toContain(one.summary.replace(/\|/g, '\\|'))
    }
    for (const grant of SERVICE_GRANTS) expect(text).toContain(`\`${grant}\``)
    for (const noun of SERVICE_NOUNS) expect(text).toContain(`## \`${noun}\``)
  })

  it('spells each service the way the CLI does', () => {
    const text = committedServiceDocs() ?? ''
    expect(text).toContain('paper book get <book>')
    expect(text).toContain('paper tag rename <from> <to>')
    expect(text).toContain('paper trash empty <count>')
    expect(text).toContain('paper book add <book> <title> [author] [--ext <string>]')
  })

  it('marks the one irreversible verb as irreversible', () => {
    const text = committedServiceDocs() ?? ''
    expect(text).toContain('**Irreversible.**')
    expect(text.match(/\*\*Irreversible\.\*\*/g)).toHaveLength(1)
  })
})

describe('the renderer', () => {
  const TWO = [
    {
      name: 'thing.list',
      noun: 'thing',
      verb: 'list',
      grant: 'thing:read',
      kind: 'stream',
      summary: 'Every thing.',
      input: [{ name: 'limit', type: 'number', doc: 'Stop after this many.' }],
      output: { many: true, of: 'ThingRow', columns: ['id'] },
    },
    {
      name: 'thing.remove',
      noun: 'thing',
      verb: 'remove',
      grant: 'thing:write',
      kind: 'req',
      summary: 'Gone | for good.',
      input: [{ name: 'thing', type: 'string', required: true, doc: 'Which one.', positional: 0 }],
      output: { many: false, of: 'Removed' },
      irreversible: true,
    },
  ]

  const rendered = () => renderServiceTable({ table: TWO, nouns: ['thing'], grants: ['thing:read', 'thing:write'] })

  it('renders a table and a section per service', () => {
    const text = rendered()
    /* PLURALISED FROM `many`, not from the type's name. `device.list` used to
     * write the plural into its shape name — `of: 'DeviceRow[]'`, a type that
     * does not exist — because `many` restated `kind` and had nowhere to say
     * "one answer, a whole list". */
    expect(text).toContain('| `thing.list` | `thing:read` | stream | `ThingRow[]` |')
    expect(text).toContain('### `thing.remove`')
    expect(text).toContain('paper thing remove <thing>')
  })

  /* A summary carrying a pipe would otherwise split a table cell in two and
   * shift every column after it — the kind of corruption a reader notices
   * long after they have stopped trusting the file. */
  it('escapes a pipe in a summary rather than breaking the row', () => {
    expect(rendered()).toContain('Gone \\| for good.')
  })

  it('ends with exactly one newline, so the file is diff-stable', () => {
    const text = rendered()
    expect(text.endsWith('\n')).toBe(true)
    expect(text.endsWith('\n\n')).toBe(false)
  })

  it('skips a noun with no services rather than emitting an empty heading', () => {
    expect(renderServiceTable({ table: TWO, nouns: ['thing', 'ghost'], grants: [] })).not.toContain('## `ghost`')
  })
})

/**
 * THE WRITER AND THE CHECK READ ONE TABLE, THE SAME WAY.
 *
 * The first version of the writer imported `serviceTable.ts` directly under
 * Node's type stripping, which worked only while the table's single import
 * was `import type` — every other module in this tree imports something at
 * runtime without a file extension, and Node's ESM resolver does not fill
 * those in. That constraint broke the day the table began quoting the
 * RECORD's own bounds instead of copying the numbers, which is the right
 * change; the constraint went rather than the reference.
 *
 * Both sides load it through Vite's SSR transform now — this file through
 * Vitest, the writer through `ssrLoadModule` — so "the reference matches the
 * descriptors" is one table read one way, and the assertion above is not a
 * comparison of two different readings of it.
 */
describe('the writer', () => {
  it('renders exactly what this file renders, through its own loader', async () => {
    await expect(currentServiceDocs(REPO_ROOT)).resolves.toBe(
      renderServiceTable({ table: SERVICE_TABLE, nouns: SERVICE_NOUNS, grants: SERVICE_GRANTS }),
    )
  }, 30_000)

  it('names the file the gate compares', () => {
    expect(DOC).toBe('docs/service-table.md')
    expect(readFileSync(path.join(REPO_ROOT, DOC), 'utf8').length).toBeGreaterThan(0)
  })
})
