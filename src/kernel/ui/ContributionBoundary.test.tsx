// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContributionBoundary, ContributionBody } from './ContributionBoundary'

afterEach(cleanup)

describe('a contributed renderer inside its boundary', () => {
  it('draws what it gives, and when it throws draws a line naming it instead of unmounting the tree', () => {
    const fine = render(
      <ContributionBoundary label="A pane">
        <ContributionBody id="cap:one" render={() => <p>drawn</p>} context={{ bookId: null }} />
      </ContributionBoundary>,
    )
    expect(screen.getByText('drawn')).toBeTruthy()
    fine.unmount()

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <>
        <p>beside it</p>
        <ContributionBoundary label="A pane">
          <ContributionBody
            id="cap:one"
            render={() => {
              throw new Error('port gone')
            }}
            context={{ bookId: null }}
          />
        </ContributionBoundary>
      </>,
    )
    expect(screen.getByText(/A pane could not be drawn\. Everything else still works\./u)).toBeTruthy()
    expect(screen.getByText('beside it')).toBeTruthy()
    expect(spy.mock.calls.some((call) => String(call[0]).includes('A pane failed to draw'))).toBe(true)
    spy.mockRestore()
  })

  it('hands the renderer the context it was given', () => {
    const seen: unknown[] = []
    render(
      <ContributionBoundary label="A pane">
        <ContributionBody
          id="cap:one"
          render={(context) => {
            seen.push(context)
            return null
          }}
          context={{ bookId: 'book:x' }}
        />
      </ContributionBoundary>,
    )
    expect(seen).toEqual([{ bookId: 'book:x' }])
  })

  /* TWO NAMES FOR TWO READERS: the label is the reader's, the id is the log's.
     One value served both, so the side pane showed a reader `circle:friends`
     and Marginalia told the log "A mark control" for every control there is. */
  it('names the contribution by its id in the log and by its label to the reader', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ContributionBoundary label="Friends" id="circle:friends">
        <ContributionBody
          id="circle:friends"
          render={() => {
            throw new Error('port gone')
          }}
          context={{ bookId: null }}
        />
      </ContributionBoundary>,
    )
    expect(screen.getByText(/Friends could not be drawn\./u)).toBeTruthy()
    expect(screen.queryByText(/circle:friends/u)).toBeNull()
    expect(spy.mock.calls.some((call) => String(call[0]).includes('circle:friends failed to draw'))).toBe(true)
    spy.mockRestore()
  })
})

describe('a boundary asked to draw another contribution', () => {
  it('starts over for the new one instead of keeping the old failure', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Broken = () => {
      throw new Error('no')
    }
    const view = render(
      <ContributionBoundary label="First" resetKey="first">
        <Broken />
      </ContributionBoundary>,
    )
    expect(screen.getByText(/First could not be drawn/u)).toBeTruthy()
    view.rerender(
      <ContributionBoundary label="Second" resetKey="second">
        <p>second drawn</p>
      </ContributionBoundary>,
    )
    expect(screen.getByText('second drawn')).toBeTruthy()
    expect(screen.queryByText(/could not be drawn/u)).toBeNull()
    spy.mockRestore()
  })
})

describe('a boundary drawn again for the same contribution', () => {
  it('keeps showing the failure until the contribution changes', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Broken = () => {
      throw new Error('no')
    }
    const view = render(
      <ContributionBoundary label="Same" resetKey="same">
        <Broken />
      </ContributionBoundary>,
    )
    expect(screen.getByText(/Same could not be drawn/u)).toBeTruthy()
    view.rerender(
      <ContributionBoundary label="Same" resetKey="same">
        <p>healthy now</p>
      </ContributionBoundary>,
    )
    expect(screen.queryByText('healthy now')).toBeNull()
    expect(screen.getByText(/Same could not be drawn/u)).toBeTruthy()
    spy.mockRestore()
  })
})
