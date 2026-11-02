import { expect, it, vi } from 'vitest'
import { capabilities } from './app/composition.web'

/**
 * The browser entry, which has one thing to do. The client has suites of its own
 * (`app/web/client.test.tsx`, `app/web/client.wiring.test.tsx`), so it stands in
 * here, and what is left is which list it is handed.
 */
const mountWebClient = vi.hoisted(() => vi.fn())
vi.mock('./app/web/client', () => ({ mountWebClient }))

it('hands the browser build’s own composition to the client, once', async () => {
  await import('./main.web')
  expect(mountWebClient).toHaveBeenCalledTimes(1)
  expect(mountWebClient.mock.calls[0]?.[0]).toBe(capabilities)
})
