// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicBookState, PublicPort } from '../lib/publicPort'
import { PublicPane } from './PublicPane'

/**
 * What this device is publishing, drawn — and the one thing that contradicts
 * all of it.
 *
 * ⚠️ **THE PLUGIN HAS EMITTED `paper://share-resume-failed` SINCE IT WAS
 * WRITTEN AND NOTHING HAD EVER HEARD IT.** Its own comment says the event
 * exists because *"a log line is not an observable failure"* — a release build
 * installs no Rust logger at all — and then the listening half was never
 * written, so the failure stayed exactly as silent with one more constant to
 * read. Meanwhile every switch on this pane is read from the policy FILE, which
 * still says the book is offered: a reader saw "offered" over an endpoint that
 * had not started, and had no way to find out. Found by audit.
 */

afterEach(cleanup)

const STATE: PublicBookState = {
  bookId: 'book:1',
  hash: 'a'.repeat(64),
  offerability: 'offerable',
  absentBecause: null,
  mayAnnotate: true,
  bytes: true,
  notes: true,
  noteCount: 2,
}

const portOver = (notServingBecause: string | null): PublicPort => ({
  forBook: () => Promise.resolve(STATE),
  offerBytes: () => Promise.resolve(),
  offerNotes: () => Promise.resolve(),
  withdraw: () => Promise.resolve(),
  importBook: () => Promise.reject(new Error('not here')),
  notServingBecause: () => notServingBecause,
  subscribe: () => () => {},
  dispose: () => {},
})

describe('the publish pane', () => {
  it('says nothing is being served when the share endpoint did not start', async () => {
    render(<PublicPane bookId="book:1" port={portOver('the share port is in use')} />)
    const said = await screen.findByText(/Nothing below is being served/u)
    expect(said.textContent).toContain('the share port is in use')
    /* NON-VACUOUS: the switches below still say "offered", which is the whole
       reason the sentence has to be here. The policy file has not changed —
       only the process that was supposed to read it has gone. */
    expect(screen.getByRole('button', { name: 'Stop offering' })).not.toBeNull()
  })

  it('says nothing of the sort when the endpoint is up', async () => {
    render(<PublicPane bookId="book:1" port={portOver(null)} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop offering' })).not.toBeNull())
    expect(screen.queryByText(/Nothing below is being served/u)).toBeNull()
  })
})
