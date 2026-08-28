// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Companion } from './Companion'
import type { AnswerEnd, AskContext, CompanionProvider } from '../../core/companion'

/**
 * What a question carries when it leaves the panel.
 *
 * `core/companion.ts` says the context holds "the passage the reader selected,
 * when the question is about one"; `numberPassages`'s docstring and the
 * ledger say the same. The panel forwarded it faithfully — and was mounted
 * without it, so every question ever asked went out with `selection: null`.
 * This pins the panel's half; `SidePane.test.tsx` pins the mounting.
 */

afterEach(cleanup)

/** A configured provider that records what it was asked and answers at once. */
function provider(): CompanionProvider & { asked: AskContext[] } {
  const asked: AskContext[] = []
  return {
    name: 'fake',
    configured: true,
    asked,
    async *ask(_question: string, context: AskContext): AsyncGenerator<string, AnswerEnd> {
      asked.push(context)
      yield 'an answer'
      return { citations: [], hadUnknownCitation: false }
    },
  }
}

function ask(question: string): void {
  const input = screen.getByLabelText('Ask the companion about this chapter')
  fireEvent.change(input, { target: { value: question } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

describe('the question the companion is sent', () => {
  it('carries the reader\'s selection when there is one', () => {
    const fake = provider()
    render(
      <Companion
        currentChapter="Loomings"
        hasBook
        provider={fake}
        bookTitle="Moby-Dick"
        selection="Call me Ishmael."
      />,
    )
    ask('who is speaking?')
    expect(fake.asked).toHaveLength(1)
    expect(fake.asked[0]?.selection).toBe('Call me Ishmael.')
    expect(fake.asked[0]?.chapterLabel).toBe('Loomings')
  })

  it('says null, not an empty string, when nothing is selected', () => {
    /* The provider tells the two apart: null is "not about a passage", and a
       prompt built around an empty passage is a different question. */
    const fake = provider()
    render(<Companion currentChapter="Loomings" hasBook provider={fake} />)
    ask('what is this chapter about?')
    expect(fake.asked[0]?.selection).toBeNull()
  })
})
