import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { KernelServices, ReaderContext, SettingsStore } from '../../../kernel'
import type { NarrationEngine } from '../lib/wire'
import { publishControl } from '../lib/running'
import { NOTES_ALOUD_SETTING, RATE_SETTING, VOICE_SETTING } from '../lib/settings'
import { useAudiobook } from './useAudiobook'

export interface ExportHostProps {
  readonly context: ReaderContext
  readonly services: KernelServices
  /** Narration's own settings: the voice, the speed and the notes the reading uses. */
  readonly settings: SettingsStore
}

/**
 * The audiobook export, run for as long as the window is.
 *
 * It renders nothing. A window host rather than a part of the reader, because an
 * export outlives the book on screen: the reader may close it, or go back to the
 * shelf, and the only way to stop the export is still the palette row.
 *
 * ⚠️ **NO VOICES, NO EXPORT.** The engine is the downloadable voices' port, read
 * from the kernel's slot; a build without them, or with them switched off, has
 * no port, so the control is null and the palette offers no row.
 */
export function ExportHost({ context, services, settings }: ExportHostProps): null {
  const { surface } = context
  const book = useSyncExternalStore(surface.subscribeBook, surface.book)
  /* THE SAME VALUES THE READING USES, read from the same settings, so the file
     holds what the reading would have said, in the voice it would have said it
     in. The snapshot is the signal; each value is read through its setting.

     ⚠️ **THE VOICE MAP IS MEMOISED ON ITS OWN STORED VALUE.** `get` parses on
     every call and so answers a new object each time; handed straight to the
     hook it would be a new export command on every render. The snapshot as a
     whole is no better a key, because it is re-filtered whenever any setting
     changes. The stored value is: the store freezes what it holds in place and
     carries every value it was not asked to change, so its identity moves only
     when the reader chooses a voice. */
  const snapshot = useSyncExternalStore(settings.subscribe, settings.getSnapshot)
  const notes = settings.get(NOTES_ALOUD_SETTING)
  const rate = settings.get(RATE_SETTING)
  const storedVoices = snapshot[VOICE_SETTING.key]
  const chosen = useMemo(() => settings.get(VOICE_SETTING), [settings, storedVoices])
  const source = useMemo(() => book && { ...book, skip: { notes } }, [book, notes])
  /* Read at render rather than once: the slot is bound by the voices
     capability's `start`, and the port it binds is one object for that run. */
  const port = services.speechEngines()
  const engine = useMemo<NarrationEngine | null>(() => {
    const renderFile = port?.renderFile
    if (!port || !renderFile) return null
    return {
      catalogue: () => port.catalogue(),
      findClip: (request) => port.findClip(request),
      holdClips: (stems, hold) => port.holdClips(stems, hold),
      renderFile: (request) => renderFile.call(port, request),
    }
  }, [port])
  const say = useCallback((text: string) => services.notify(text), [services])
  const control = useAudiobook({
    source,
    chosen,
    rate,
    engine,
    say,
  })
  /* Withdrawn by the same effect that published it, so a host that goes — the
     window closing, or a fault — leaves no control behind for the row to read. */
  useEffect(() => (control ? publishControl(control) : undefined), [control])
  return null
}
