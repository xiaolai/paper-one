// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_LINKS_DISCLOSURE, disclosureFor, linksVoiceToPerson, type PublicPassage } from '../../../kernel'
import type { PublishPublicPort } from '../lib/publishPort'
import { PublishControl } from './PublishControl'

/**
 * The publish control — WI-26.4's surface.
 *
 * ⚠️ **THIS FILE EXISTS BECAUSE THERE WAS NO FILE.** `PublishControl` had no
 * test, and the defect that hid there was not a wrong branch but a MISSING
 * PROP: the running app never passed `sharedWithCircle`, so it defaulted to an
 * empty array, `linksVoiceToPerson` always answered `false`, and the strongest
 * privacy warning in the app could not appear on any screen. Every unit test of
 * the rule passed throughout. What was missing was a test of the WIRING.
 */

afterEach(cleanup)

const PASSAGE: PublicPassage = { quote: 'Call me Ishmael', prefix: '', suffix: '', chapter: 'Loomings' }

const portWith = (over: Partial<PublishPublicPort> = {}): PublishPublicPort =>
  ({
    /* The real rule, not a stub: a stubbed disclosure would pass whatever this
       component handed it and prove nothing about the wiring. */
    disclosure: (audience: 'circle' | 'public', passage: PublicPassage, sharedWithCircle: readonly PublicPassage[]) =>
      disclosureFor(audience, linksVoiceToPerson(passage, sharedWithCircle)),
    publish: vi.fn(() => Promise.resolve({ pub: 'p1', voice: 'be'.repeat(32) })),
    withdraw: vi.fn(() => Promise.resolve()),
    voice: () => Promise.resolve('be'.repeat(32)),
    ...over,
  }) as unknown as PublishPublicPort

const button = (name: string | RegExp) => screen.queryByRole('button', { name })

describe('the publish control', () => {
  it('publishes nothing on the first click — the disclosure is a step', async () => {
    const port = portWith()
    render(<PublishControl bookId="book:1" passage={PASSAGE} port={port} />)
    button('Publish…')?.click()
    await waitFor(() => expect(button('Publish to anyone')).not.toBeNull())
    expect(port.publish).not.toHaveBeenCalled()
  })

  /* ⚠️ **THE ONE THIS FILE WAS WRITTEN FOR.** */
  it('warns that the words are already in the circle, when they are', async () => {
    render(
      <PublishControl
        bookId="book:1"
        passage={PASSAGE}
        port={portWith()}
        sharedWithCircle={() => Promise.resolve([{ ...PASSAGE, chapter: 'a different label' }])}
      />,
    )
    button('Publish…')?.click()
    await waitFor(() => expect(screen.queryByText(new RegExp(PUBLIC_LINKS_DISCLOSURE, 'u'))).not.toBeNull())
  })

  it('does not warn about linkage for a passage the circle has never seen', async () => {
    render(
      <PublishControl
        bookId="book:1"
        passage={PASSAGE}
        port={portWith()}
        sharedWithCircle={() => Promise.resolve([{ ...PASSAGE, quote: 'something else entirely' }])}
      />,
    )
    button('Publish…')?.click()
    await waitFor(() => expect(button('Publish to anyone')).not.toBeNull())
    expect(screen.queryByText(new RegExp(PUBLIC_LINKS_DISCLOSURE, 'u'))).toBeNull()
  })

  /* A build with no circle composed — every phone — passes nothing, and empty
     is the TRUE answer there rather than a default standing in for one. */
  it('shows the plain disclosure when no circle is composed', async () => {
    render(<PublishControl bookId="book:1" passage={PASSAGE} port={portWith()} />)
    button('Publish…')?.click()
    await waitFor(() => expect(button('Publish to anyone')).not.toBeNull())
    expect(screen.queryByText(new RegExp(PUBLIC_LINKS_DISCLOSURE, 'u'))).toBeNull()
    expect(screen.queryByText(/goes to anyone, not to your circle/u)).not.toBeNull()
  })

  /* ⚠️ **THE DEFECT AS A RACE.** Publishing while the circle is still being
     asked would commit under the weaker warning — the same outcome as never
     asking, reached a different way. */
  it('cannot publish while the circle has not answered yet', async () => {
    let answer: (passages: readonly PublicPassage[]) => void = () => {}
    const pending = new Promise<readonly PublicPassage[]>((resolve) => {
      answer = resolve
    })
    const port = portWith()
    render(<PublishControl bookId="book:1" passage={PASSAGE} port={port} sharedWithCircle={() => pending} />)
    button('Publish…')?.click()
    await waitFor(() => expect(screen.queryByText(/Checking what you have already shared/u)).not.toBeNull())

    const publish = button('Publish to anyone')
    expect(publish?.hasAttribute('disabled'), 'publishing was offered before the warning was known').toBe(true)
    publish?.click()
    expect(port.publish).not.toHaveBeenCalled()

    answer([{ ...PASSAGE }])
    await waitFor(() => expect(screen.queryByText(new RegExp(PUBLIC_LINKS_DISCLOSURE, 'u'))).not.toBeNull())
  })

  it('still lets a reader publish when the circle cannot be read', async () => {
    render(
      <PublishControl
        bookId="book:1"
        passage={PASSAGE}
        port={portWith()}
        sharedWithCircle={() => Promise.reject(new Error('the circle file will not read'))}
      />,
    )
    button('Publish…')?.click()
    /* The base disclosure, and a usable control: an unreadable circle file must
       not become an error on the public path. */
    await waitFor(() => expect(screen.queryByText(/goes to anyone, not to your circle/u)).not.toBeNull())
    expect(button('Publish to anyone')?.hasAttribute('disabled')).toBe(false)
  })

  it('asks again for the next publication, because the acknowledgement is per act', async () => {
    const port = portWith()
    render(<PublishControl bookId="book:1" passage={PASSAGE} port={port} />)
    button('Publish…')?.click()
    await waitFor(() => expect(button('Publish to anyone')).not.toBeNull())
    button('Publish to anyone')?.click()
    await waitFor(() => expect(screen.queryByText(/Published\./u)).not.toBeNull())

    /* A fresh mark is a fresh act, and it starts at the first step — the
       acknowledgement never carries over. */
    cleanup()
    render(<PublishControl bookId="book:1" passage={{ ...PASSAGE, quote: 'another' }} port={port} />)
    expect(button('Publish to anyone'), 'the second act skipped its disclosure').toBeNull()
    expect(button('Publish…')).not.toBeNull()
  })
})
