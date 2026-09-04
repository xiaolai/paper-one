/**
 * Tell every listener, each on its own.
 *
 * ⚠️ **ONE LISTENER THAT THROWS MUST NOT SILENCE THE REST, NOR MAKE AN ACT
 * THAT ALREADY LANDED READ AS FAILED.** A port tells its subscribers after
 * the write, and a subscriber is a screen: a screen that throws is a screen
 * with a defect, and the other screens — and the caller waiting on the act —
 * are owed the news all the same. Iterated over a copy, because a listener
 * may unsubscribe while being told.
 */
export function tellEach(listeners: ReadonlySet<() => void>, what: string): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (cause) {
      console.warn(`Paper: a ${what} listener threw`, cause)
    }
  }
}
