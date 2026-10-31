import { open, save } from '@tauri-apps/plugin-dialog'
import { readTextFile, stat, writeTextFile } from '@tauri-apps/plugin-fs'
import { createFilePicker, type FileFilter, type FilePicker } from '../core/pickedFile'

/**
 * The platform's half of `pickedFile`, and nothing else: a dialog, and the three
 * calls that touch the one file it answered. On the storage-adapter list for the
 * same reason as its neighbours; no path is constructed here, only received from
 * a dialog the reader answered.
 */
const mutable = (filters: readonly FileFilter[]) =>
  filters.map(({ name, extensions }) => ({ name, extensions: [...extensions] }))

export function tauriFilePicker(): FilePicker {
  return createFilePicker({
    showOpen: (filters) => open({ multiple: false, directory: false, filters: mutable(filters) }),
    showSave: (name, filters) => save({ defaultPath: name, filters: mutable(filters) }),
    size: async (path) => (await stat(path)).size,
    readText: (path) => readTextFile(path),
    writeText: (path, text) => writeTextFile(path, text),
  })
}
