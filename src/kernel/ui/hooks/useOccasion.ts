import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * A value that counts as NEW every time it is raised — even when it is the same.
 *
 * React bails out of a `setState` to an identical value, and a surface whose
 * timer is keyed on what it holds then does not restart for a repeat: the same
 * failure reported twice vanished almost as it appeared, and a second jump out of
 * the same chapter ran out on the first one's clock. The fix both times was to
 * hold the value with a NONCE minted per raise, so every raise is a different
 * object and the timer keys on the occasion rather than the text.
 *
 * ⚠️ **ONE HOOK, AND IT WAS TWO COPIES IN `App`.** The import notice and the
 * return hint each kept a `useState` of `{ payload, nonce }`, a ref counter, and a
 * raiser that bumped it — the same six lines with a different field name, each
 * with its own copy of the two mutation directives below and its own comment
 * saying it had learned this from the other. Minted in one place now, so a third
 * surface that needs it cannot forget the nonce.
 *
 * The payload's shape is the caller's — `{ text }`, `{ label }` — so the value
 * held is exactly what the consuming component already reads.
 */
export function useOccasion<T extends object>(): readonly [
  (T & { readonly nonce: number }) | null,
  (value: T) => void,
  Dispatch<SetStateAction<(T & { readonly nonce: number }) | null>>,
] {
  const [held, setHeld] = useState<(T & { readonly nonce: number }) | null>(null)
  /* A ref, not `n + 1` off the held value: callers clear it to null between
     raises, so its own count is not there to read. */
  const count = useRef(0)
  const raise = useCallback(
    (value: T) => {
      // Stryker disable next-line AssignmentOperator: the nonce is the OCCASION, compared only for inequality, so counting down is the same sequence backwards — every raise still differs from the one before it.
      count.current += 1
      setHeld({ ...value, nonce: count.current })
    },
    // Stryker disable next-line ArrayDeclaration: a constant dependency list is a constant identity whatever is in it, and this reads only a ref and `useState`'s setter.
    [],
  )
  return [held, raise, setHeld] as const
}
