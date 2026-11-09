import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { KernelServices, ReaderContext } from '../../../kernel'
import type { NarrationEngine } from '../lib/wire'
import { publishControl } from '../lib/running'
import { useAudiobook } from './useAudiobook'

export interface ExportHostProps {
  readonly context: ReaderContext
  readonly services: KernelServices
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
export function ExportHost({ context, services }: ExportHostProps): null {
  const { surface } = context
  const book = useSyncExternalStore(surface.subscribeBook, surface.book)
  /* THE SAME VALUES THE READING USES, so the file holds what the reading would
     have said, in the voice it would have said it in. */
  const voice = context.voice
  const notes = voice?.notesAloud ?? false
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
    chosen: voice?.chosen ?? NO_CHOICE,
    rate: voice?.rate ?? 1,
    engine,
    say,
  })
  /* Withdrawn by the same effect that published it, so a host that goes — the
     window closing, or a fault — leaves no control behind for the row to read. */
  useEffect(() => (control ? publishControl(control) : undefined), [control])
  return null
}

/** One empty choice, so a missing voice does not change the hook's inputs on every render. */
const NO_CHOICE: Readonly<Record<string, string>> = {}
