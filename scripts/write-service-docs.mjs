import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { isProcessEntry } from './lib/entry.mjs'
import { renderServiceTable } from './lib/service-docs.mjs'

/**
 * `pnpm docs:services` — write `docs/service-table.md` from the descriptors
 * (phase 11, WI-11.8).
 *
 * IT LOADS THE TYPESCRIPT THROUGH VITE, and the first version did not — it
 * imported `serviceTable.ts` directly under Node's type stripping, which
 * worked only because the table's single import was `import type` and was
 * therefore erased. Every other module in this tree imports something at
 * runtime WITHOUT a file extension, which Node's ESM resolver does not fill
 * in, so that trick held exactly as long as the table imported nothing.
 *
 * It stopped holding the day the table began quoting the RECORD's own field
 * bounds (`MAX_RECORD_FIELD`) instead of copying the numbers — which is the
 * right change and the whole point of the file. So the constraint went rather
 * than the reference: `ssrLoadModule` is the same transform Vitest uses to
 * read the table in `check-service-docs.test.mjs`, so the writer and the
 * check now load it the same way and cannot disagree about what it says.
 *
 * `--check` compares instead of writing, and exits 1 on a difference. The
 * test is the gate; the flag is for a human who wants the same answer at a
 * terminal without reading a test report.
 */

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
export const DOC = 'docs/service-table.md'
export const TABLE_MODULE = 'src/kernel/core/serviceTable.ts'

/**
 * The reference, as the descriptors say it is.
 *
 * The dev server is started and closed around the one load; it is a few
 * hundred milliseconds for a command that runs when somebody edits the table.
 */
export async function currentServiceDocs(root = REPO_ROOT) {
  const server = await createServer({
    root,
    /* NOT the app's config: it installs the composition resolver, the React
     * plugin and the pdf.js copy step, and would fail without a platform. */
    configFile: false,
    logLevel: 'error',
    /* `custom`, so Vite does not treat this as a web app and try to crawl
     * `index.html` — which is where its dependency scanner starts, and which
     * has nothing to do with reading one module. `noDiscovery` stops the
     * pre-bundle for the same reason: the table imports nothing from
     * `node_modules`. */
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null },
  })
  try {
    const table = await server.ssrLoadModule(path.join(root, TABLE_MODULE))
    return renderServiceTable({ table: table.SERVICE_TABLE, nouns: table.SERVICE_NOUNS, grants: table.SERVICE_GRANTS })
  } finally {
    await server.close()
  }
}

/** What is committed, or null when nothing is. */
export function committedServiceDocs(root = REPO_ROOT) {
  try {
    return readFileSync(path.join(root, DOC), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function main(argv) {
  const check = argv.includes('--check')
  const generated = await currentServiceDocs()
  if (!check) {
    writeFileSync(path.join(REPO_ROOT, DOC), generated)
    process.stdout.write(`write-service-docs: ${DOC} (${generated.split('\n').length} lines)\n`)
    return 0
  }
  const committed = committedServiceDocs()
  if (committed === generated) {
    process.stdout.write(`write-service-docs: ${DOC} is current\n`)
    return 0
  }
  process.stderr.write(
    committed === null
      ? `write-service-docs: ${DOC} is missing — run \`pnpm docs:services\`\n`
      : `write-service-docs: ${DOC} has drifted from the descriptors — run \`pnpm docs:services\`\n`,
  )
  return 1
}

if (isProcessEntry(import.meta)) {
  process.exitCode = await main(process.argv.slice(2))
}
