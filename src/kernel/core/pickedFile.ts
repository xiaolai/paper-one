/**
 * A file the reader chose, as a handle and never as a path.
 *
 * A capability may not import the dialog or fs plugins (`.dependency-cruiser.cjs`),
 * and that boundary is what keeps its reach inside what the kernel hands it. An
 * archive still has to reach a file anywhere on the disk, so this is the door: the
 * reader points, and the capability is handed the one thing they pointed at.
 *
 * ⚠️ **THE PATH STAYS IN THIS CLOSURE, AND THAT IS THE CONFINEMENT.** A
 * `PickedFile` holds four members and no path. There is nothing to read a path
 * from, nothing to build a sibling's path out of, and no call that takes a path,
 * so a capability holding one can touch that file and only that file. `name` is
 * the last segment alone, because a full path in `name` would be the same leak
 * with a friendlier label: it would say where the reader keeps things, and name
 * the folder a later request could aim at.
 *
 * ⚠️ **AND THE PICK DECIDES THE DIRECTION.** The dialog that said Open asked to
 * read, and is no consent to overwrite; the dialog that said Save asked to write,
 * and is no consent to read what is already at that name. Both directions are
 * refused loudly rather than by leaving the method off, so `PickedFile` stays one
 * shape and a caller using it the wrong way finds out on the first run.
 *
 * ⚠️ **AND THE PLATFORM'S OWN SENTENCES STOP HERE.** A file deleted between the pick
 * and the read rejects with `failed to read file as text at path: …`, and handed on
 * unchanged that gives the capability the very path the closure keeps. So every call
 * across this line fails in a fixed sentence with no `cause`, and the original goes
 * to the log on this side, the way the kernel's other adapters keep theirs.
 *
 * Path-yielding picks (the audiobook's, whose Rust half takes a path) are a
 * different door with their own review. They do not belong on this one.
 */

/** One row of a dialog's format list. */
export interface FileFilter {
  readonly name: string
  readonly extensions: readonly string[]
}

export interface PickedFile {
  /** The file's own name, with no folder: `notes.md`. */
  readonly name: string
  size(): Promise<number>
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

export interface FilePicker {
  /** False where this build has no dialog. A caller omits the control rather than offering one that refuses. */
  readonly available: boolean
  /** Null when the reader dismissed the dialog, which is not a failure. */
  pickOpen(filters: readonly FileFilter[]): Promise<PickedFile | null>
  /** Null when the reader dismissed the dialog. `name` is the bare file name offered, which the reader may change; a folder in it is refused. */
  pickSave(name: string, filters: readonly FileFilter[]): Promise<PickedFile | null>
}

/** The platform's half: what a dialog and a filesystem do, with paths, on the kernel's side of the line. */
export interface FilePickerIo {
  /** Whatever the dialog answered. Only a single string counts as a pick. */
  showOpen(filters: readonly FileFilter[]): Promise<unknown>
  showSave(name: string, filters: readonly FileFilter[]): Promise<unknown>
  size(path: string): Promise<number>
  readText(path: string): Promise<string>
  writeText(path: string, text: string): Promise<void>
}

/** The last path segment, whichever separator the platform used. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/u).pop() ?? ''
}

/** A platform call whose failure says only `sentence`. Async, so a throw is caught as a rejection is. */
async function across<T>(sentence: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (cause) {
    console.error(`Paper: ${sentence}`, cause)
    throw new Error(sentence)
  }
}

function handle(path: string, direction: 'read' | 'write', io: FilePickerIo): PickedFile {
  const refuse = (verb: string, asked: string) =>
    new Error(`A file picked to ${direction} cannot be ${verb}: the reader was asked to ${asked}`)
  /* FROZEN, so nothing can be hung on the handle and passed along as if the kernel
     had said it, and every member below reads `path` from the closure. */
  return Object.freeze<PickedFile>({
    name: fileNameOf(path),
    size: () =>
      direction === 'read'
        ? across('The picked file could not be measured', () => io.size(path))
        : Promise.reject(refuse('measured', 'save')),
    readText: () =>
      direction === 'read'
        ? across('The picked file could not be read', () => io.readText(path))
        : Promise.reject(refuse('read', 'save')),
    writeText: (text) =>
      direction === 'write'
        ? across('The picked file could not be written', () => io.writeText(path, text))
        : Promise.reject(refuse('written', 'open')),
  })
}

/* A dismissed dialog answers null. An array (a multi-select that should not have
   been possible) is refused as no pick rather than guessed at. */
const chosenPath = (answer: unknown): string | null =>
  typeof answer === 'string' && answer !== '' ? answer : null

const NO_DIALOG = 'The file dialog could not be shown'

/* ⚠️ **THE DIALOG OPENS WHERE THE SUGGESTED NAME SAYS**, so a path here would let a
   capability choose the location and leave the reader only to press Return: the
   door is the reader pointing, and this would be the capability pointing for them.
   Both separators on every platform, because the check should not depend on where
   the test ran, and `..` anywhere, because no name a capability offers needs it. */
function refuseAFolder(name: string): void {
  if (/[\\/]/u.test(name) || name.includes('..')) {
    throw new Error('A name offered to the save dialog must be a bare file name, with no folder in it')
  }
}

export function createFilePicker(io: FilePickerIo): FilePicker {
  return {
    available: true,
    pickOpen: async (filters) => {
      const path = chosenPath(await across(NO_DIALOG, () => io.showOpen(filters)))
      return path === null ? null : handle(path, 'read', io)
    },
    pickSave: async (name, filters) => {
      refuseAFolder(name)
      const path = chosenPath(await across(NO_DIALOG, () => io.showSave(name, filters)))
      return path === null ? null : handle(path, 'write', io)
    },
  }
}

/**
 * Where no dialog exists: says so through `available`, and refuses loudly for a
 * caller that did not ask, because answering null would read as a dismissed dialog
 * and a control that silently does nothing.
 */
export const NO_FILE_PICKER: FilePicker = {
  available: false,
  pickOpen: () => Promise.reject(new Error('This build has no file dialog')),
  pickSave: () => Promise.reject(new Error('This build has no file dialog')),
}
