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
  CapabilityError,
  KERNEL_DEFAULT_PANE,
  RESERVED_ID,
  composeCapabilities,
  isCapabilityId,
  kernelApi,
  registrationOrder,
  resolvePaneId,
  /* THE CAPABILITY SETTINGS CONTRACT, exported so a capability's own tests can
   * hold themselves to it. A store built by hand in a test is a guard that can
   * drift from the real one — and it did: both phase-15 panes read
   * `kernel.lookUp` through their scoped handle and threw `namespace` on their
   * first render, while every unit test passed because each had been handed an
   * UNSCOPED store. */
  scopeSettings,
} from './core/registry'
export type { CapabilityErrorCode, Composition, CompositionOptions, Contributions } from './core/registry'

/* THE SERVICE TABLE — the one declaration the router registration, the client
 * stubs, the CLI's commands and `docs/service-table.md` are all derived from
 * (phase 11). Public because all four consumers sit outside the kernel. */
export {
  GRANT_FAMILIES,
  SERVICE_GRANTS,
  SERVICE_NAMES,
  SERVICE_NOUNS,
  SERVICE_TABLE,
  SERVICE_VERBS,
  flagFields,
  grantCovers,
  positionalFields,
  readServices,
  readingGrant,
  serviceClients,
  serviceDescriptor,
  servicesOn,
  writeServices,
} from './core/serviceTable'
export type {
  FieldType,
  GrantFamily,
  ServiceDescriptor,
  ServiceField,
  ServiceGrant,
  ServiceKind,
  ServiceName,
  ServiceNoun,
  ServiceOutput,
  ServiceVerb,
} from './core/serviceTable'

/* The table's HANDLERS, and the ports the three nouns the kernel cannot
 * answer for arrive through. `buildServices` is what a composition root hands
 * to `serveServices`, and what an in-process caller runs directly — one set
 * of handlers, three ways of reaching them. */
export { buildReadServices, buildServices, handlerFor } from './core/services/handlers'
export type { DevicePort, DeviceRow, ServiceEnvironment, ShelfFacts, ShelfPort, SizePort } from './core/services/environment'
export { SERVICE_ERRORS, isRefusal, refuse } from './core/services/refusals'
export type { Refusal, ServiceErrorCode } from './core/services/refusals'
export { PAGE_BYTES, PAGE_ROWS, pages } from './core/services/paging'
export type {
  BookDetail,
  BookRow,
  CardRow,
  ContentLocation,
  EmptiedRow,
  MarkRow,
  RemovedRow,
  RestoredRow,
  ShelfStatus,
  TagChange,
  TagCountRow,
  TrashRow,
} from './core/services/rows'

/* The ports, and their defaults. */
export { MUTATION_KINDS, NOOP_DIAGNOSTICS, NOOP_RECORDER, defineSetting, recorded, BLOB_FOLDER } from './core/ports'
export type {
  ContentBlobName,
  DeviceRole,
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
export { CAPABILITY_UI, type CapabilityUiClass } from './core/capabilityUi'
/* WHAT A CONTRIBUTED `render()` DRAWS — see `core/renderSlot.ts`. */
export { createRenderSlot } from './core/renderSlot'
export type { RenderSlot } from './core/renderSlot'
/* The first half of a shutdown: hand over what memory holds, so the queue has
 * something to drain. The composition root needs it for the QUIT path, which
 * is not the window-close path `App` already covers — see `beforeClose.ts`. */
export { flushBeforeClose, onBeforeClose } from './core/beforeClose'
/* The companion and the gloss (phase 15). The types a capability implements
 * to bind `KernelServices.bindCompanion` / `bindGloss`, and the constants a
 * settings pane renders the Look up cycle from. */
export { NOT_CONFIGURED, NOT_CONFIGURED_REASON, UNKNOWN_CITATION_NOTE } from './core/companion'
export type { AnswerEnd, AskContext, AskPassage, Citation, CompanionProvider } from './core/companion'
export { LOOK_UP_LABELS, LOOK_UP_MODES, LOOK_UP_SETTING, NO_GLOSS, availableModes, effectiveMode, isLookUpMode } from './core/gloss'
export type { GlossContext, GlossProvider, LookUpMode } from './core/gloss'
export { KERNEL_SETTINGS, SETTINGS_STORAGE_KEY, SETTINGS_VERSION, carryLegacySettings, createSettingsStore, keepValues } from './core/settings'
export type { KernelPreferences, SettingsEnvelope, SettingsMigration, SettingsStoreOptions } from './core/settings'

/* Storage primitives a capability writes through, and the record they write.
 * The paths and readers are here because the sync journal digests a book's
 * CURRENT folder state; they read and derive, never write — the write paths
 * stay behind the stores. */
export {
  BOOKS_DIR,
  DEVICE_LOCAL_FIELDS,
  MAX_RECORD_FIELD,
  MAX_RECORD_POSITION,
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
export { CONTENT_EXTENSIONS, isContentExtension, isKnownExtension } from './core/bookVault'
export type { BookRecord, TagClock, TagClockEntry } from './core/bookFolder'
export { INDEX_FILE, loadShelf, parseIndex, scanBooks, writeIndex } from './core/bookIndex'
export type { IndexFs, IndexedBook, ShelfSource } from './core/bookIndex'
/* The FLAT STORE's seam and its opener. Public since phase 11: a host outside
 * the webview has to build the same two filesystems the app builds — the
 * library's `IndexFs` and this one — and `main.tsx` is not a place a second
 * host can import from. `appStorage.ts` is the app's implementation of the
 * same interface, and stays where it is. */
export { STORE_FILE, openFileStore } from './core/fileStore'
export type { FileStore, FileStoreOptions, FileSystem } from './core/fileStore'
/* `fakeFs` LIVED HERE AND HAS MOVED to `src/kernel/testkit.ts`.
 *
 * It is a deliberately behaviour-divergent stand-in for a filesystem, and
 * exporting it from the PRODUCTION entry put it in the supported API and in
 * the generated declarations beside `createKernelServices`. Tree-shaking meant
 * it cost a build nothing — a fact about bundle size, not about whether
 * somebody can import it — and the boundary rules could not tell the
 * difference, because it arrived through the one door everything may use.
 *
 * The test entry is refused to production code by name
 * (`kernel-testkit-in-tests-only`), which is the distinction this file could
 * not express. */
/* Standing aside between books, for a long background pass — see `breath`.
 * Public because sync's contentHash backfill is one of the two passes that
 * need it, and the other is the kernel's own enrichment. */
export { breathe, restThenBreathe } from './core/breath'
/* LAST-ISSUED WINS. Two subsystems raced their own async results and each
   had grown a private counter; see `core/generations.ts`. */
export { createGenerations } from './core/generations'
export type { Generations } from './core/generations'
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
export type { ContentExtension, KnownExtension, VaultFs } from './core/bookVault'

/* The vocabulary. */
export { createMark, liveMarks, markStamp, mergeMarks, validMarks } from './core/marks'
export type { Mark, MarkKind, MarkStorage, NewMark } from './core/marks'
export { CARDS_STORAGE_KEY, cardStamp, liveCards, mergeCards, parseCards } from './core/cards'
export type { Card, CardKind, NewCard } from './core/cards'
export { KERNEL_PANE_IDS, isContributedPaneId, isKernelPaneId } from './core/uiTypes'
export type { ContributedPaneId, KernelPaneId, PageLayout, PaneId, Screen, Side, Theme, Typeface } from './core/uiTypes'
