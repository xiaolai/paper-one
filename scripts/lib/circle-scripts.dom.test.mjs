// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AT_SHELF,
  FRIEND_SHELF_STATE,
  IDENTITY,
  OPEN_FRIEND_SHELF,
  OPEN_MARGINALIA,
  PERSON_SWITCHES,
  READ_MARKS,
  SHARE_FIRST_UNSHARED,
  TO_CIRCLE,
  TO_SHELF,
  clickShare,
  filterShelf,
  flipSwitch,
  openMatch,
  rowState,
  shelfMatches,
  stateOfRow,
  withdrawRow,
} from './circle-scripts.mjs'

/**
 * The driver's scripts, RUN — against a DOM shaped like the app's.
 *
 * ⚠️ **`circle-scripts.test.mjs` CHECKS THAT THEY PARSE, AND THAT IS NOT THE
 * SAME AS CHECKING THAT THEY WORK.** Mutation testing put the file at 65 %: a
 * generated script is a string, so every selector, every guard and every
 * refusal inside one could be emptied with the whole suite still green. Forty
 * survivors, and among them the class attribute that keeps a run from sharing
 * another book's passage and the uniqueness check that keeps it from
 * disclosing a shelf to the wrong Ann.
 *
 * A script that is only compiled is a script whose CONTENT is untested. These
 * are evaluated in a real document and asked what they answered.
 */

/** Run one script the way the bridge does, and read its JSON back. */
const run = (script) => JSON.parse(String(eval(script)))

/** jsdom implements no `innerText`; `READ_MARKS` reads one. */
beforeEach(() => {
  document.body.innerHTML = ''
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent
    },
  })
})

const html = (markup) => {
  document.body.innerHTML = markup
  return document.body
}

/** A Marginalia row: a share control wrapped in enough ancestors to be found. */
const markRow = ({ quote, buttons = ['Share'], otherBook = null, padding = 'x'.repeat(40) }) =>
  `<div class="row">` +
  `<div class="pad">${padding}</div>` +
  (otherBook === null ? '' : `<div class="placeBook">${otherBook}</div>`) +
  `<div class="noteJump">${quote}</div>` +
  `<div data-mark-control="circle:share">${buttons.map((one) => `<button>${one}</button>`).join('')}</div>` +
  `</div>`

describe('where am I, and how do I get back', () => {
  it('says it is on the shelf only when the library search field is there', () => {
    expect(run(AT_SHELF).shelf).toBe(false)
    html('<input aria-label="Search the library" />')
    expect(run(AT_SHELF).shelf).toBe(true)
  })

  it('clicks the Library control, and names the failure when there is none', () => {
    expect(run(TO_SHELF)).toEqual({ ok: false, why: 'no way back to the shelf from here' })
    html('<button aria-label="Other">n</button><button aria-label="Library">L</button>')
    const clicked = vi.fn()
    document.querySelector('button[aria-label="Library"]').addEventListener('click', clicked)
    expect(run(TO_SHELF)).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('clicks the Circle control, and names the failure when there is none', () => {
    expect(run(TO_CIRCLE)).toEqual({ ok: false, why: 'no Circle control in the titlebar' })
    html('<button aria-label="Circle">C</button>')
    const clicked = vi.fn()
    document.querySelector('button').addEventListener('click', clicked)
    expect(run(TO_CIRCLE)).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('clicks the Marginalia tab, and names the failure when no book is open', () => {
    expect(run(OPEN_MARGINALIA)).toEqual({ ok: false, why: 'no Marginalia tab — no book is open' })
    html('<button aria-label="Marginalia">M</button>')
    const clicked = vi.fn()
    document.querySelector('button').addEventListener('click', clicked)
    expect(run(OPEN_MARGINALIA)).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})

describe('narrowing the shelf and opening a book', () => {
  it('counts the cells a title matches, by the label PREFIX', () => {
    html('<button aria-label="More for Moby-Dick, the whale">m</button><button aria-label="More for Dune">d</button>')
    expect(run(shelfMatches('Moby-Dick')).cells).toBe(1)
    expect(run(shelfMatches('Nothing')).cells).toBe(0)
  })

  it('types the title through the NATIVE setter, so React sees it', () => {
    expect(run(filterShelf('Moby'))).toEqual({ ok: false, why: 'no library search field on screen' })
    html('<input aria-label="Search the library" />')
    const input = document.querySelector('input')
    const heard = vi.fn()
    input.addEventListener('input', heard)
    expect(run(filterShelf('Moby-Dick'))).toEqual({ ok: true })
    expect(input.value).toBe('Moby-Dick')
    expect(heard).toHaveBeenCalledTimes(1)
    expect(heard.mock.calls[0][0].bubbles).toBe(true)
  })

  it('names each step of opening a row that is not there', () => {
    expect(run(openMatch('Moby-Dick'))).toEqual({ ok: false, why: 'no shelf row matched that title' })
    html('<button aria-label="More for Moby-Dick">m</button>')
    expect(run(openMatch('Moby-Dick'))).toEqual({ ok: false, why: 'the matched row has no cell around it' })
    html('<div class="cell"><button aria-label="More for Moby-Dick">m</button></div>')
    expect(run(openMatch('Moby-Dick'))).toEqual({ ok: false, why: 'the shelf row has no opener button' })
  })

  it('clicks the opener — the button that is NOT the More button', () => {
    html('<div class="cell"><button aria-label="More for Moby-Dick">m</button><button aria-label="Open">o</button></div>')
    const more = vi.fn()
    const open = vi.fn()
    document.querySelector('button[aria-label^="More for"]').addEventListener('click', more)
    document.querySelector('button[aria-label="Open"]').addEventListener('click', open)
    expect(run(openMatch('Moby-Dick'))).toEqual({ ok: true })
    expect(open).toHaveBeenCalledTimes(1)
    expect(more).not.toHaveBeenCalled()
  })
})

describe('sharing the first unshared mark of the OPEN book', () => {
  it('refuses when every row is already shared', () => {
    html(markRow({ quote: 'Call me Ishmael', buttons: ['Withdraw'] }))
    expect(run(SHARE_FIRST_UNSHARED)).toEqual({
      ok: false,
      why: 'no unshared mark of the open book — withdraw one, or mark a fresh passage',
    })
  })

  it('skips a row belonging to ANOTHER book, which is what placeBook marks', () => {
    /* ⚠️ Sharing somebody else's row publishes a passage from a book the far
       end was never asked about. */
    html(markRow({ quote: 'From another book', otherBook: 'Dune' }))
    expect(run(SHARE_FIRST_UNSHARED).ok).toBe(false)
  })

  it('refuses a quote two rows of this book share, rather than picking one', () => {
    /* ⚠️ Checked BEFORE the click: clicking first published the passage and
       left the poll and the withdrawal unable to name it. */
    html(markRow({ quote: 'Same words' }) + markRow({ quote: 'Same words' }))
    const clicked = vi.fn()
    for (const b of document.querySelectorAll('button')) b.addEventListener('click', clicked)
    expect(run(SHARE_FIRST_UNSHARED)).toEqual({
      ok: false,
      why: 'every unshared mark of this book shares its first 120 characters with another row, so nothing here can be polled or withdrawn unambiguously',
    })
    expect(clicked).not.toHaveBeenCalled()
  })

  it('clicks Share on the first unambiguous row, and answers with its quote', () => {
    html(markRow({ quote: 'Same words' }) + markRow({ quote: 'Same words' }) + markRow({ quote: 'Call me Ishmael' }))
    const clicked = vi.fn()
    for (const b of document.querySelectorAll('button')) b.addEventListener('click', clicked)
    expect(run(SHARE_FIRST_UNSHARED)).toEqual({ ok: true, quote: 'Call me Ishmael' })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('needs a noteJump to read a quote from, and skips a row with none', () => {
    html('<div class="row"><div data-mark-control="circle:share"><button>Share</button></div></div>')
    expect(run(SHARE_FIRST_UNSHARED).ok).toBe(false)
  })
})

describe('the row carrying one quote — polled and withdrawn by the same rule', () => {
  it('says the row is gone when nothing carries the quote', () => {
    html(markRow({ quote: 'Another passage' }))
    expect(run(stateOfRow('Call me Ishmael'))).toEqual({
      ok: false,
      why: 'the row carrying that passage is no longer on screen',
    })
    expect(run(withdrawRow('Call me Ishmael'))).toEqual({ ok: false, why: 'no row of this book carries that passage' })
  })

  it('refuses rather than guessing when two rows carry it', () => {
    html(markRow({ quote: 'Same words' }) + markRow({ quote: 'Same words' }))
    expect(run(stateOfRow('Same words')).why).toMatch(/^2 rows of this book carry that passage — refusing rather than guessing which$/u)
    expect(run(withdrawRow('Same words')).why).toMatch(/^2 rows of this book carry that passage — refusing to withdraw rather than guessing which$/u)
  })

  it('does NOT count a row of another book toward the ambiguity, nor withdraw it', () => {
    /* ⚠️ The same first 120 characters in a different book is a different
       passage, and withdrawing it takes back something nobody asked about. */
    html(markRow({ quote: 'Same words' }) + markRow({ quote: 'Same words', otherBook: 'Dune', buttons: ['Withdraw'] }))
    expect(run(stateOfRow('Same words'))).toMatchObject({ ok: true, buttons: ['Share'] })
    const clicked = vi.fn()
    for (const b of document.querySelectorAll('button')) b.addEventListener('click', clicked)
    expect(run(withdrawRow('Same words'))).toEqual({ ok: false, why: 'that row is not shared, so there is nothing to withdraw' })
    expect(clicked).not.toHaveBeenCalled()
  })

  it('reads the buttons and the text of the one row that carries it', () => {
    html(markRow({ quote: 'Call me Ishmael', buttons: ['Share', 'Withdraw'] }))
    expect(run(stateOfRow('Call me Ishmael'))).toMatchObject({ ok: true, buttons: ['Share', 'Withdraw'], text: 'ShareWithdraw' })
  })

  it('clicks Withdraw, and only Withdraw', () => {
    html(markRow({ quote: 'Call me Ishmael', buttons: ['Share', 'Withdraw'] }))
    const share = vi.fn()
    const withdraw = vi.fn()
    const [a, b] = document.querySelectorAll('button')
    a.addEventListener('click', share)
    b.addEventListener('click', withdraw)
    expect(run(withdrawRow('Call me Ishmael'))).toEqual({ ok: true })
    expect(withdraw).toHaveBeenCalledTimes(1)
    expect(share).not.toHaveBeenCalled()
  })

  it('matches on the first 120 characters, which is what the caller polls on', () => {
    const long = 'a'.repeat(200)
    html(markRow({ quote: long }))
    expect(run(stateOfRow(long.slice(0, 120))).ok).toBe(true)
  })
})

describe('the indexed row scripts', () => {
  it('names a row that has left the screen', () => {
    expect(run(clickShare(0))).toEqual({ ok: false, why: 'that row is not on screen — the list moved under the driver' })
    expect(run(rowState(0))).toEqual({ ok: false, why: 'the row left the screen mid-publish' })
  })

  it('names a row that offers no Share', () => {
    html('<div data-mark-control="circle:share"><button>Withdraw</button></div>')
    expect(run(clickShare(0))).toEqual({ ok: false, why: 'that row offers no Share button' })
  })

  it('clicks the Share of the row at that index, and reads its state back', () => {
    html('<div data-mark-control="circle:share"><button>Withdraw</button></div><div data-mark-control="circle:share"><button>Share</button></div>')
    const clicked = vi.fn()
    document.querySelectorAll('button')[1].addEventListener('click', clicked)
    expect(run(clickShare(1))).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
    expect(run(rowState(1))).toEqual({ ok: true, buttons: ['Share'], text: 'Share' })
    expect(run(rowState(0))).toEqual({ ok: true, buttons: ['Withdraw'], text: 'Withdraw' })
  })
})

describe('the Circle screen’s switches', () => {
  const switches = (rows) => html(rows.map(([label, checked]) => `<input type="checkbox" aria-label="${label}" ${checked ? 'checked' : ''} />`).join(''))

  it('lists both kinds of per-person switch and nothing else', () => {
    switches([
      ['Hold back Ann’s passages', true],
      ['Show my shelf to Ann', false],
      ['Some other setting', true],
    ])
    expect(run(PERSON_SWITCHES)).toEqual({
      ok: true,
      boxes: [
        { label: 'Hold back Ann’s passages', checked: true },
        { label: 'Show my shelf to Ann', checked: false },
      ],
    })
  })

  it('names a switch that is not there', () => {
    expect(run(flipSwitch('Show my shelf to Ann', true))).toEqual({ ok: false, why: 'no switch labelled Show my shelf to Ann' })
  })

  it('REFUSES two people carrying one label rather than disclosing to whichever drew first', () => {
    switches([
      ['Show my shelf to Ann', false],
      ['Show my shelf to Ann', false],
    ])
    const clicked = vi.fn()
    for (const b of document.querySelectorAll('input')) b.addEventListener('click', clicked)
    expect(run(flipSwitch('Show my shelf to Ann', true))).toEqual({
      ok: false,
      why: '2 people carry the label Show my shelf to Ann — refusing rather than picking one',
    })
    expect(clicked).not.toHaveBeenCalled()
  })

  it('leaves a switch already in the state it wants alone, and says so', () => {
    switches([['Show my shelf to Ann', true]])
    const clicked = vi.fn()
    document.querySelector('input').addEventListener('click', clicked)
    expect(run(flipSwitch('Show my shelf to Ann', true))).toEqual({ ok: true, already: true })
    expect(clicked).not.toHaveBeenCalled()
  })

  it('clicks the one that is not', () => {
    switches([['Show my shelf to Ann', false]])
    const clicked = vi.fn()
    document.querySelector('input').addEventListener('click', clicked)
    expect(run(flipSwitch('Show my shelf to Ann', true))).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})

describe('a friend’s shelf', () => {
  it('opens it, reports it already open, and names the failure when the row is not there', () => {
    expect(run(OPEN_FRIEND_SHELF)).toEqual({ ok: false, why: 'no "Their shelf" button on the Circle screen' })
    html('<button>Hide their shelf</button>')
    expect(run(OPEN_FRIEND_SHELF)).toEqual({ ok: true })
    html('<button>Their shelf</button>')
    const clicked = vi.fn()
    document.querySelector('button').addEventListener('click', clicked)
    expect(run(OPEN_FRIEND_SHELF)).toEqual({ ok: true })
    expect(clicked).toHaveBeenCalledTimes(1)
  })

  it('reports whether it is showing, and counts the jackets drawn', () => {
    html('<img /><img />')
    expect(run(FRIEND_SHELF_STATE)).toEqual({ ok: true, showing: false, images: 2 })
    html('<button>Hide their shelf</button><img />')
    expect(run(FRIEND_SHELF_STATE)).toEqual({ ok: true, showing: true, images: 1 })
  })
})

describe('the reader’s own marks, as Marginalia lists them', () => {
  it('reports each row, its buttons, whether it is shared, and which book it belongs to', () => {
    html(markRow({ quote: 'Call me Ishmael', buttons: ['Share'] }) + markRow({ quote: 'The spice', buttons: ['Withdraw'], otherBook: 'Dune' }))
    const read = run(READ_MARKS)
    expect(read.ok).toBe(true)
    expect(read.rows).toHaveLength(2)
    expect(read.rows[0]).toMatchObject({ i: 0, buttons: ['Share'], shared: false, otherBook: null })
    /* ⚠️ The attribution is the placeBook CLASS, not a text prefix. */
    expect(read.rows[1]).toMatchObject({ i: 1, buttons: ['Withdraw'], shared: true, otherBook: 'Dune' })
    expect(read.rows[0].text).toContain('Call me Ishmael')
  })
})

describe('the identity a device answers with', () => {
  it('says withGlobalTauri is off when the global is not exposed', async () => {
    expect(JSON.parse(await eval(IDENTITY))).toEqual({
      ok: false,
      why: 'window.__TAURI__ is not exposed — withGlobalTauri is false, so this is not the dev config',
    })
  })

  it('says the device has never shared when the plugin answers nothing', async () => {
    window.__TAURI__ = { core: { invoke: () => Promise.resolve(null) } }
    expect(JSON.parse(await eval(IDENTITY))).toEqual({
      ok: false,
      why: 'this device has no person identity — it has never shared',
    })
    delete window.__TAURI__
  })

  it('reports the person, the device, the delegation’s field names and the roster SIZE', async () => {
    /* The roster is a count, not a list: a scenario log is not a place to
       print every device key a reader owns. */
    const invoke = vi.fn(() =>
      Promise.resolve({ person: 'p1', device: 'd1', delegation: { sig: 'x', person: 'p1', notBefore: 1 }, roster: ['d1', 'd2'] }),
    )
    window.__TAURI__ = { core: { invoke } }
    expect(JSON.parse(await eval(IDENTITY))).toEqual({
      ok: true,
      person: 'p1',
      device: 'd1',
      delegationKeys: ['notBefore', 'person', 'sig'],
      roster: 2,
    })
    expect(invoke).toHaveBeenCalledWith('plugin:peer|peer_circle_mine')
    delete window.__TAURI__
  })
})
