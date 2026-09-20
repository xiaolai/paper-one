import { useEffect, useState } from 'react'
import { speechAvailable } from '../reader/speech'
import type { VoiceFacts } from '../reader/voiceChoice'

/**
 * The voices this machine can read aloud with.
 *
 * ⚠️ **`getVoices()` IS EMPTY UNTIL THE ENGINE HAS LOADED ITS LIST, AND THAT IS
 * NOT AN ERROR.** It is populated asynchronously and announced with
 * `voiceschanged`, so a surface that reads it once at mount shows an empty
 * picker for the first moments of a session and never corrects itself. The
 * deleted `core/voice.ts` recorded the same measurement for the same API and
 * drew the same conclusion: empty means *not yet*, never *none*.
 *
 * ⚠️ **AND THE EVENT FIRES MORE THAN ONCE.** A reader who downloads a voice in
 * System Settings while Paper is open gets it without relaunching — which is
 * the whole reason this is a subscription rather than a read. It is also how
 * the picker stops being a lie the moment somebody installs the Enhanced voice
 * the app has been telling them to get.
 *
 * NO POLLING AND NO TIMEOUT. An engine that never fires the event leaves the
 * list at whatever the first synchronous read gave, which on WebKit is the
 * whole list; a timer would only add a second answer to reconcile.
 */
export function useVoices(): readonly VoiceFacts[] {
  const [voices, setVoices] = useState<readonly VoiceFacts[]>(EMPTY)

  useEffect(() => {
    if (!speechAvailable()) return
    const engine = window.speechSynthesis
    /* READ IMMEDIATELY AS WELL AS ON THE EVENT. WebKit answers a populated list
     * synchronously once anything has asked it, and by the time a reader opens
     * the settings panel something has — so waiting for an event that has
     * already fired would show an empty picker for ever. */
    const read = () => {
      const got = engine.getVoices()
      /* EMPTY IS NOT PUBLISHED OVER A LIST WE ALREADY HAVE. Some engines answer
       * `[]` transiently while reloading their list, and replacing a good list
       * with nothing makes the picker flicker to "no voices" and back. Nothing
       * is lost by keeping the old one: the next event carries the new list. */
      if (got.length > 0) setVoices(got)
    }
    read()
    engine.addEventListener('voiceschanged', read)
    return () => engine.removeEventListener('voiceschanged', read)
  }, [])

  return voices
}

/* A module constant, so a machine with no engine hands back the same array
 * every render rather than a new empty one — which would re-run every effect
 * and memo downstream that lists the voices as a dependency. */
const EMPTY: readonly VoiceFacts[] = []
