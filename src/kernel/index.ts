/**
 * The kernel's public entry — the ONLY kernel module anything outside
 * `src/kernel/` may import (`.dependency-cruiser.cjs`, rule
 * `kernel-public-entry-only`).
 *
 * NOTHING REACT. What is here is the non-React kernel: the services a
 * composition root builds and a capability's `start` receives, the ports a
 * capability may implement, and the few storage primitives and types a
 * capability writing under a book's folder needs. The hooks, screens and
 * panes are the kernel's own UI and stay behind this line; a capability
 * contributes UI through the `Capability` interface — a pane's `render` is an
 * opaque handle here (`PaneRenderer`) that the UI layer narrows. The UI's
 * own entry, for composition roots only, is `./ui/index.ts`.
 *
 * Whatever is exported from here is the kernel's public surface: it is what
 * `.types/kernel` describes and what `pnpm boundaries:decls` scans, so a type
 * that reaches into a capability cannot cross this line unnoticed. (That scan
 * is textual and reads doc comments too — which is why nothing here spells
 * the forbidden path.)
 */

/* The services, and the factory a composition root calls once. */
export { createKernelServices } from './core/services'
export type { KernelServices, KernelServicesOptions } from './core/services'
export { createLibrary } from './core/libraryStore'
export type { Library, LibraryOptions, RekeyOutcome, RemoteRow } from './core/libraryStore'
export { createMarkStore } from './core/markStore'
export type { MarkSnapshot, MarkStore, MarkStoreOptions } from './core/markStore'
export { createCard, createCards } from './core/cardStore'
export type { CardSnapshot, CardStorage, Cards, CardsOptions } from './core/cardStore'

/* The contribution API — what a capability is — and the registry that composes a set of them. */
export type {
  BookAction,
  Capability,
  CapabilityContext,
  ClientContribution,
  Command,
  CommandContext,
  Disposable,
  KernelApi,
  PaneContribution,
  PaneRenderer,
  ServiceContext,
  ServiceContribution,
  ServiceHandler,
  SettingsSection,
} from './core/capability'
export {
  CAPABILITY_ID,
  CapabilityError,
  KERNEL_DEFAULT_PANE,
  RESERVED_ID,
  composeCapabilities,
  kernelApi,
  registrationOrder,
  resolvePaneId,
} from './core/registry'
export type { CapabilityErrorCode, Composition, Contributions } from './core/registry'

/* The ports, and their defaults. */
export { MUTATION_KINDS, NOOP_DIAGNOSTICS, NOOP_RECORDER, contentBlobPort, defineSetting, recorded, BLOB_FOLDER } from './core/ports'
export type {
  ContentBlobName,
  ContentBlobPort,
  Diagnostics,
  MutationKind,
  MutationRecorder,
  MutationToken,
  RemovableBlobName,
  Setting,
  SettingKey,
  SettingsStore,
} from './core/ports'
export { createDiagnostics, defaultDiagnostics, redact } from './core/diagnostics'
export type { DiagnosticsOptions, Sink } from './core/diagnostics'
export { KERNEL_SETTINGS, SETTINGS_STORAGE_KEY, SETTINGS_VERSION, createSettingsStore, keepValues } from './core/settings'
export type { KernelPreferences, SettingsEnvelope, SettingsMigration, SettingsStoreOptions } from './core/settings'

/* Storage primitives a capability writes through, and the record they write.
 * The paths and readers are here because the sync journal digests a book's
 * CURRENT folder state; they read and derive, never write — the write paths
 * stay behind the stores. */
export {
  BOOKS_DIR,
  DEVICE_LOCAL_FIELDS,
  TRASH_DIR,
  atomicWrite,
  folderOf,
  marksPathIn,
  parseRecord,
  readBook,
  readMarks,
  recordPath,
  setTag,
  tagRegisters,
  tagsFromClock,
  trashOf,
} from './core/bookFolder'
export { CONTENT_EXTENSIONS } from './core/bookVault'
export type { BookRecord, TagClock, TagClockEntry } from './core/bookFolder'
export type { IndexFs, IndexedBook } from './core/bookIndex'
export { writeQueue } from './core/writeQueue'
export type { WriteQueue } from './core/writeQueue'
export { tagKey } from './core/tags'

/* The ledger's primitives: the stamp, the presence register, the formats. */
export {
  HLC_MAX_COUNTER,
  HLC_MAX_MS,
  ZERO_DEVICE,
  asHlc,
  compareHlc,
  deviceOf,
  hlcOf,
  isDeviceId,
  isHlc,
  laterHlc,
  makeHlc,
  parseHlc,
} from './core/hlc'
export type { Hlc } from './core/hlc'
export {
  PRESENCE_KEY,
  PRESENCE_PATH,
  finishPendingRemovals,
  notePresence,
  readPresence,
  recordStamp,
  writePresence,
} from './core/presence'
export type { Presence, PresenceEntry, PresenceState } from './core/presence'
export { FORMATS, formatOf, isFormat, sniffFormat } from './core/formats'
export type { Format } from './core/formats'
export type { TrashFs } from './core/bookTrash'
export type { VaultFs } from './core/bookVault'

/* The vocabulary. */
export { createMark, liveMarks, markStamp, mergeMarks, validMarks } from './core/marks'
export type { Mark, MarkKind, MarkStorage, NewMark } from './core/marks'
export { CARDS_STORAGE_KEY, cardStamp, liveCards, mergeCards, parseCards } from './core/cards'
export type { Card, CardKind, NewCard } from './core/cards'
export { KERNEL_PANE_IDS, isContributedPaneId, isKernelPaneId } from './core/uiTypes'
export type { ContributedPaneId, KernelPaneId, PageLayout, PaneId, Screen, Side, Theme, Typeface } from './core/uiTypes'
