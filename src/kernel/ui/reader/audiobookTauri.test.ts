import { describe, expect, it } from 'vitest'
import { safeFileName } from './audiobookTauri'

/**
 * ⚠️ **EVERY CASE HERE CAME BACK UNCHANGED BEFORE THE FIX, AND WINDOWS REFUSES
 * EVERY ONE OF THEM.** The function's own comment claimed "any platform this
 * ships to" while it handled POSIX only; the export being macOS-gated is why
 * nothing noticed. These are the seven names a refutation pass ran through it.
 */
describe('safeFileName', () => {
  it('replaces every character Windows forbids, not only the POSIX ones', () => {
    expect(safeFileName('Why?')).toBe('Why')
    expect(safeFileName('a*b')).toBe('a b')
    expect(safeFileName('a|b')).toBe('a b')
    expect(safeFileName('a"b')).toBe('a b')
    expect(safeFileName('a<b>')).toBe('a b')
  })

  it('still replaces the separators, which is what it was written for', () => {
    expect(safeFileName('Vol/2')).toBe('Vol 2')
    expect(safeFileName('Vol\\2')).toBe('Vol 2')
    expect(safeFileName('Dune: Part Two')).toBe('Dune  Part Two')
  })

  it('suffixes a reserved device name rather than replacing the title', () => {
    /* A book called `Con` is not far-fetched, and the dialog's refusal explains
       nothing. The reader should still recognise their own title in it. */
    expect(safeFileName('CON')).toBe('CON (book)')
    expect(safeFileName('nul')).toBe('nul (book)')
    expect(safeFileName('Com4')).toBe('Com4 (book)')
    expect(safeFileName('LPT9')).toBe('LPT9 (book)')
  })

  it('leaves a title that merely starts with a device name alone', () => {
    expect(safeFileName('Conrad')).toBe('Conrad')
    expect(safeFileName('Auxiliary Verbs')).toBe('Auxiliary Verbs')
  })

  it('drops a trailing dot, which Windows strips without saying so', () => {
    /* The file would then be named differently from the suggestion the reader
       accepted, which is the kind of difference nobody can diagnose. */
    expect(safeFileName('Vol. 2.')).toBe('Vol. 2')
    expect(safeFileName('Hmm...')).toBe('Hmm')
  })

  it('drops a trailing dot the truncation itself created', () => {
    /* ⚠️ **THE ORDER IS LOAD-BEARING.** Cutting at 120 characters can CREATE a
       trailing dot, so a trim done before the slice would not see it. */
    const title = `${'a'.repeat(119)}.tail`
    expect(safeFileName(title)).toBe('a'.repeat(119))
  })

  it('keeps a non-Latin title exactly as it is', () => {
    expect(safeFileName('第三章')).toBe('第三章')
  })

  it('strips control characters and a leading dot', () => {
    expect(safeFileName('a\u0007b')).toBe('ab')
    expect(safeFileName('...hidden')).toBe('hidden')
  })

  it('answers empty for a title made only of forbidden characters', () => {
    /* `chooseAudiobookPath` falls back to `audiobook` on an empty answer, so
       this must be empty rather than a string of spaces. */
    expect(safeFileName('???')).toBe('')
    expect(safeFileName('   ')).toBe('')
  })
})
