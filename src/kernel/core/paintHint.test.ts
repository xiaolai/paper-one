import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIGRATED_KEYS } from './fileStore'
import { PAINT_HINT_KEY } from './paintHint'

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')

describe('the first frame’s colour', () => {
  it('is read in index.html under the key the app writes', () => {
    /* The inline script cannot import this constant — it runs before any module
       exists, which is the whole point of it. So the two are checked against
       each other here. A rename that missed the HTML would pass the build, pass
       the types, and show up only as a white flash nobody traces back. */
    expect(html).toContain(PAINT_HINT_KEY)
  })

  it('runs before the module script, or it cannot paint anything', () => {
    /* Order is the mechanism. A hint applied after the bundle has been fetched
       is a hint applied after the frame it exists to colour. */
    expect(html.indexOf(PAINT_HINT_KEY)).toBeLessThan(html.indexOf('/src/main.tsx'))
  })

  it('sits in <head>, because that is where the BUILD puts the module script', () => {
    /* Authored in <body> this was correct in dev and wrong in `dist`: Vite
       injects the bundle at the end of <head>, so the hint ran after it and
       painted a frame that had already been drawn. Nothing but a real build
       showed it — `pnpm dev` serves the file as written. */
    expect(html.indexOf(PAINT_HINT_KEY)).toBeLessThan(html.indexOf('</head>'))
  })

  it('leaves the charset inside the first 1024 bytes', () => {
    /* The spec's limit, and this test exists because the hint was briefly put
       ABOVE the charset: its comment alone pushed the declaration past 1024
       bytes, where a browser is entitled to have guessed an encoding already.
       Nothing failed — the page rendered — which is exactly why it needs an
       assertion rather than a memory. */
    const at = html.indexOf('charset')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(Buffer.byteLength(html.slice(0, at), 'utf8')).toBeLessThan(1024)
  })

  it('does not reuse a key the localStorage migration reads', () => {
    /* `MIGRATED_KEYS` are localStorage names too, and the migration carries
       whatever it finds under them into the file store. A colour arriving where
       a library was expected is the same class of collision `paper.library.v1`
       already produced once. */
    expect(MIGRATED_KEYS as readonly string[]).not.toContain(PAINT_HINT_KEY)
  })
})
