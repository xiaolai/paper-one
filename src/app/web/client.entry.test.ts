import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

/**
 * THE ONE LINE NO TEST MAY LOAD.
 *
 * `src/main.web.tsx` imports `virtual:paper-composition`, so a test that imported
 * it would be back on the route the mutation gate cannot see down, which is what
 * moving the client out of it ended. Reading it is not loading it. So its one
 * statement is held here as text: deleting the call, or growing the file past it,
 * fails this, and that is the mutant its `Stryker disable` line says nothing else
 * can reach.
 */
it('the browser entry hands this build’s composition to the client, and does nothing else', () => {
  const source = readFileSync(new URL('../../main.web.tsx', import.meta.url), 'utf8')
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  expect(code).toEqual([
    "import { mountWebClient } from './app/web/client'",
    "import { capabilities } from 'virtual:paper-composition'",
    'mountWebClient(capabilities)',
  ])
})
