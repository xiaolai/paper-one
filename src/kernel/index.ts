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
 * stubs, the CLI's commands and `dev-docs/service-table.md` are all derived from
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
/* EVERYTHING A CAPABILITY'S `start` ACQUIRED — see `core/capabilitySession.ts`. */
export { openSession } from './core/capabilitySession'
export type { CapabilitySession } from './core/capabilitySession'
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
/* WHAT A BOOK'S LINK MAY DO TO THE HOST, decided once and in one place.
 *
 * foliate hands any link whose scheme leaves the package to `globalThis.open`
 * unless the embedder cancels the event, and `epub.js`'s idea of "external" is
 * every scheme but `blob:` — so `javascript:` and `data:` take the same branch.
 * The desktop reader has cancelled that event and consulted this since the
 * `open_external` work; the BROWSER reader passed a no-op handler, which
 * cancels nothing, so the fallback ran with whatever a stranger's zip put in
 * the href. Pure and already browser-safe, so the client uses the same rule
 * rather than growing a second one that drifts. */
export { MAX_URL, externalTarget } from './core/externalLink'
export type { ExternalTarget } from './core/externalLink'
/* HOW MUCH OF A READER-CHOSEN FILE THIS APP WILL HOLD. Three paths read
 * something whose size is decided outside the app — a picked archive, a book on
 * a shelf — and none of them bounded it before reading. See `importLimits`. */
export { ARCHIVE_MAX_BYTES, ARCHIVE_MAX_ROWS, BOOK_MAX_BYTES, tooLarge } from './core/importLimits'
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
/* ⚠️ `tauriSizePort` IS NOT RE-EXPORTED HERE, and that absence is load-bearing.
 *
 * It was, from `./core/bookSizes` — and because that module also held the
 * `@tauri-apps/plugin-fs` binding, this entry, which every capability imports,
 * could not be bundled for a browser. One export made 54 modules unreachable
 * and earned a bespoke dependency-cruiser rule to route around it.
 *
 * The binding now lives in `core/bookSizesTauri.ts` and the composition root
 * imports it directly, which is the right shape anyway: a book's size is a fact
 * about the app's own data directory, so the root binds it, not a capability
 * and not this barrel. `sizePortOver` — the PURE WALK — is exported below, and
 * that is the whole point of the split: it has real logic in it (an extension
 * preference order, a partial-answer rule, a root-safe join) and every host
 * should run THAT rather than a copy of it. The Node host kept its own copy
 * until one of them started at `books/` and the other at the data root, and
 * `shelf.status.bytes` came to depend on which host you asked.
 *
 * `scripts/check-browser-safe.mjs` pins this entry as browser-safe. Re-adding a
 * platform-bound export here fails that gate rather than being discovered
 * months later by a bundle that will not build. */
export { sizePortOver } from './core/bookSizes'
export type { SizeOps } from './core/bookSizes'
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
/* THE CLOSED DOMAINS, exported so a client can VALIDATE a wire row against
 * them rather than casting. Reading somebody else's JSON and trusting `kind`
 * to be one of three strings is how an unknown value reaches a switch with no
 * case for it — see `app/web/wireRow.ts`. */
export { MARK_KINDS, MARK_STYLES, MARK_TINTS } from './core/marks'
export type { MarkStyle } from './core/marks'
export { createMark, isAnnotation, isBookmark, liveMarks, markStamp, mergeMarks, validMarks } from './core/marks'
export type { Annotation, Bookmark, Mark, MarkKind, MarkStorage, MarkTint, NewMark } from './core/marks'
export { CARD_KINDS, CARDS_STORAGE_KEY, cardStamp, liveCards, mergeCards, parseCards } from './core/cards'
export type { Card, CardKind, NewCard } from './core/cards'
export { KERNEL_PANE_IDS, isContributedPaneId, isKernelPaneId } from './core/uiTypes'
export type { ContributedPaneId, KernelPaneId, PageLayout, PaneId, Screen, Side, Theme, Typeface } from './core/uiTypes'


/* The design system's icon sizes. Exported for a capability's UI: `lucide`
 * takes a number, and a capability picking its own would be the one control in
 * the app drawn at a size nothing else uses. `ICON.control` is the size every
 * icon inside a control already takes. */
export { ICON } from './core/metrics'

/* THE ENVELOPE — a service call as bytes, and bytes back.
 *
 * It lived in `capabilities/peer/lib/` because that is where its first caller
 * was, and nothing about it is peer-to-peer: it is a request/response framing
 * over any ordered byte stream. Phase 18 gave it a second transport (a browser
 * over a WebSocket) and the misplacement became load-bearing — the browser
 * client cannot import from `peer`, whose index reaches `@tauri-apps` and does
 * not exist in a browser.
 *
 * So it lives here, where both transports can reach it. `peer/lib/envelope.ts`
 * re-exports it, which is why nothing in that capability had to change. */
export {
  DEFAULT_TIMEOUT_MS,
  ENVELOPE_ERRORS,
  ENVELOPE_SERVICE,
  ENVELOPE_VERSION,
  FrameTooLarge,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_JSON_DEPTH,
  MAX_PAYLOAD_BYTES,
  MalformedFrame,
  ServiceCallError,
  UNKNOWN_ID,
  UnsupportedVersion,
  createClient,
  createRouter,
  decodeFrame,
  encodeFrame,
  parseFrame,
  serviceError,
} from './core/envelope'
export type {
  CallOptions,
  Client,
  ClientOptions,
  Frame,
  FrameKind,
  Router,
  RouterConnection,
  RouterOptions,
  ServiceError,
  Timers,
} from './core/envelope'
