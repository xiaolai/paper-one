import { messageOf } from '../../../kernel'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { KnownPerson, PersonPort, PersonStatus } from '../../peer'

/**
 * The reader's own custody and the people they know, as the Circle screen
 * reads them — the read model, and only that. What the reader DOES with
 * each is a section's own, with action state of its own.
 *
 * ⚠️ **ONE READ, NOT TWO.** The status carries the circle's SIZE, so a
 * roster read apart from it left a status that disagreed with the list
 * beside it for as long as the second call took. The three facts the
 * status is computed from — the people, the device count, the record —
 * are read together and published together.
 */
export interface PersonRead {
  readonly status: PersonStatus | null
  readonly people: readonly KnownPerson[]
  /**
   * "I could not read your circle" — which replaces the whole screen,
   * because there is nothing true to draw it from.
   *
   * ⚠️ SHOWN, NOT SWALLOWED. A screen that fails to read the identity and
   * renders the empty state is telling the reader they have no circle,
   * which is a different and much worse claim than "I could not look".
   */
  readonly failure: string | null
  /** Read again — after an act, or a pairing result. */
  readonly refresh: () => Promise<void>
}

export function usePerson(port: PersonPort | null): PersonRead {
  const [status, setStatus] = useState<PersonStatus | null>(null)
  const [people, setPeople] = useState<readonly KnownPerson[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * Which read is the newest — the same revision `useOverlays` keeps.
   *
   * ⚠️ **AN OLDER ANSWER COULD OVERWRITE A NEWER ONE.** A refresh started by
   * a pairing result would publish the new person, and a slow initial
   * refresh then landed and put the empty roster back — along with a status
   * computed for a circle of zero. Every read commits only if it is still
   * the latest.
   */
  const read = useRef(0)
  /** Cleared on unmount, so nothing sets state into a gone component. */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (port === null) return
    const mine = ++read.current
    try {
      const met = await port.people()
      /* ⚠️ **THE ROSTER'S SIZE, FROM THE ROSTER — WI-23.A3.** This was a prop
         the capability filled with a hardcoded 1, so the at-risk marker stood
         on every device a reader owned however many they had paired. */
      const devices = await port.devices()
      const now = await port.status(devices, met.length)
      if (!live.current || read.current !== mine) return
      setPeople(met)
      setStatus(now)
      setFailure(null)
    } catch (cause) {
      if (!live.current || read.current !== mine) return
      setFailure(messageOf(cause))
    }
  }, [port])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { status, people, failure, refresh }
}
