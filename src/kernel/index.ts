/**
 * The kernel's public entry — the only kernel module a capability, or anything
 * else under `src/` outside the kernel, may import (`.dependency-cruiser.cjs`,
 * rule `kernel-public-entry-only`).
 *
 * The shells and the composition roots are not exemptions from that rule. It
 * leaves them out of its `from` entirely, and each is judged by a rule of its
 * own that names its kernel doors exactly: `composition-root-kernel-entries`,
 * `web-client-kernel-entries`, `mobile-client-kernel-entries` and
 * `shared-shell-kernel-entries`. The browser client's, for one, admits this
 * entry, `ui/browser`, and five browser-safe leaves. Read the lists in the
 * rules — they are what a build enforces, and a copy of one here is how this
 * header came to be wrong.
 *
 * ⚠️ **THIS HEADER CALLED THEM "THE EXEMPTIONS THAT RULE NAMES", AND GAVE THE
 * BROWSER TWO MODULES.** Both were stale: the exemption was replaced by the
 * separate rules, and the browser's door lists seven. Found by audit.
 *
 * ⚠️ **THE REASON ONCE GIVEN FOR THE SEPARATE DOORS WAS THAT THIS BARREL PULLS
 * IN `@tauri-apps`, AND IT DOES NOT.** `pnpm browser:check` holds this exact
 * module and passes: every platform binding was split out of the kernel
 * (`vaultFsTauri.ts` from `bookVault.ts` is the pattern), which is what made
 * the kernel reachable from a browser at all. What the doors are really for is
 * WEIGHT and REACT: a barrel's re-exports evaluate with the barrel, so a web
 * bundle that wanted two surfaces would load every one of them, and
 * `ui/browser` is the entry that grows one export at a time for that reason. A
 * rationale that names a blocker which no longer exists is one somebody will
 * remove the door over. Found by audit.
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
 *
 * ⚠️ **AN EXPORT NOBODY IMPORTS COSTS A MODULE LOAD ONLY WHEN NOTHING ELSE
 * HERE ALREADY LOADS THAT MODULE — AND MOST DO.** An audit counted two hundred
 * names in this file with no importer and read them as weight. They are not:
 * almost every one sits beside a name that IS imported, in a module the barrel
 * loads anyway. They stay, because they are a declared contract rather than a
 * cost, and shrinking a contract on the grounds that today's capabilities
 * happen not to use it is a different decision from removing dead weight.
 *
 * ⚠️ **`core/cardStore` AND `core/formats` WERE DROPPED AS "THE TWO MODULES
 * THAT COST", AND NEITHER COST ANYTHING.** Both still load with this entry:
 * `core/services.ts` imports `createCards` from the one and `core/bookFolder.ts`
 * imports `isFormat` from the other, and this file re-exports both of those.
 * What dropping the clauses bought is a smaller API — names nothing outside the
 * kernel asked for — which is reason enough; the loading saving was a second
 * reason that was not true. Found by audit.
 *
 * `kernel-entry.test.mjs` holds the NAMES, not the loading: it refuses a value
 * clause none of whose names anything outside the entry imports, whether or not
 * something else here loads the module behind it. It does not walk the module
 * graph, so it can neither confirm nor refute a claim about what loads.
 */

/* The services, and the factory a composition root calls once. */
export { createKernelServices } from './core/services'
export type { KernelServices, KernelServicesOptions } from './core/services'
export { createLibrary } from './core/libraryStore'
export type { BookPatch, Library, LibraryOptions, RekeyOutcome, RemoteRow } from './core/libraryStore'
/* The one reader of a rejection's text. In the kernel because a capability
   cannot import another capability's, which is how three broken copies of it
   came to exist — see the module's own header. */
export { notifyAll } from './core/notify'
export { isMissingFile } from './core/bookVault'
export { messageOf } from './core/messageOf'
export { createMarkStore } from './core/markStore'
export type { MarkSnapshot, MarkStore, MarkStoreOptions } from './core/markStore'
export type { UnplacedMark } from './core/marks'

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
  MarkControl,
  PaneContext,
  PaneContribution,
  ScreenContribution,
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
   * drift from the real one — and it did: two deleted phase-15 panes read a
   * `kernel.` key through their scoped handle and threw `namespace` on their
   * first render, while every unit test passed because each had been handed an
   * UNSCOPED store. */
  scopeSettings,
} from './core/registry'
export type { CapabilityErrorCode, Composition, CompositionOptions, Contributions } from './core/registry'

/* THE SERVICE TABLE — the one declaration the router registration, the client
 * stubs and the CLI's commands are all derived from (phase 11). Public because
 * the consumers sit outside the kernel. `dev-docs/service-table.md` is NOT
 * derived from it: that document is hand-kept and drifts (WI-20.37 found it
 * two services and a grant behind); `serviceTable.test.ts` holds the CODE to
 * one declaration, and nothing holds the document. */
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
  WithdrawnField,
} from './core/serviceTable'

/* The table's HANDLERS, and the ports the three nouns the kernel cannot
 * answer for arrive through. `buildServices` is what a composition root hands
 * to `serveServices`, and what an in-process caller runs directly — one set
 * of handlers, three ways of reaching them. */
export { buildReadServices, buildServices, handlerFor } from './core/services/handlers'
export type {
  DevicePort,
  DeviceRow,
  HashPort,
  InstallProgress,
  ServiceEnvironment,
  ShelfFacts,
  ShelfPort,
  SizePort,
  SpeechEnginePort,
  SpeechRequest,
  SpokenAudio,
  SpokenWordTiming,
  VoiceChoice,
  VoicePack,
} from './core/services/environment'
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
export {
  createDiagnosticLog,
  createDiagnosticSpool,
  DEFAULT_CAPACITY,
  DEFAULT_FLUSH_MS,
  DIAGNOSTICS_FILE,
  DIAGNOSTICS_SWITCH,
} from './core/diagnosticsLog'
export type { DiagnosticEntry, DiagnosticLog, DiagnosticSpool } from './core/diagnosticsLog'
export { CAPABILITY_UI, type CapabilityUiClass } from './core/capabilityUi'
export { inlineQrSvg } from './core/qrSvg'
/* ⚠️ **`core/capabilitySession.ts` AND `core/renderSlot.ts` ARE DELETED**, with
 * the clauses that re-exported them. `openSession` released everything a
 * capability's `start` acquired; `createRenderSlot` was a STACK for the value a
 * no-argument `render()` draws, so two live compositions could not leave the
 * older one rendering nothing. Both were right, and both had exactly two
 * callers — the deleted `companion` and `inference`.
 *
 * They were kept for one round on the ground that `webhost` hand-rolls the same
 * ownership check and would be the next caller. That is a plan, not a caller.
 * Code with no caller and a comment explaining who might want it is the shape
 * this repository keeps having to delete twice.
 *
 * THE DEFECT IS RECORDED WHERE IT HAPPENS, not here and not in a deleted
 * header: `capabilities/webhost/index.ts` and its `index.test.ts` carry it,
 * because webhost is the one capability that still has it. A third case is
 * rebuilt from that incident rather than from the abstraction. */
/* The first half of a shutdown: hand over what memory holds, so the queue has
 * something to drain. The composition root needs it for the QUIT path, which
 * is not the window-close path `App` already covers — see `beforeClose.ts`.
 *
 * AND `onBeforeDrain`, the list of work already RUNNING that the drain waits
 * for (2026-09-14). Registering is how anything outside the kernel puts a wait
 * on both shutdown paths — and how `app/bootApp.test.ts` proves the quit's
 * teardown is handed `settleBeforeDrain` at all, since a test under `src/app/`
 * reaches the kernel through this entry and no other. The waiting half stays on
 * `ui/boot.ts`, beside the bound it runs under. */
export { flushBeforeClose, onBeforeClose, onBeforeDrain } from './core/beforeClose'
/* ⚠️ **THE COMPANION, THE GLOSS AND THE VOICE PORTS ARE ALL GONE FROM HERE.**
 * `NOT_CONFIGURED`, `CompanionProvider`, `Definition`, `GlossProvider`,
 * `Voice`, `AnswerLanguage` and the rest were the shapes a capability
 * implemented to bind `bindCompanion` / `bindGloss` / `bindVoice`. There are no
 * such ports: every AI feature — the companion, Look up, the neural voice and
 * the inference capability behind all three — was removed in one pass, and a
 * barrel that still named their types would be the surface by which they came
 * back one import at a time. A barrel's re-exports evaluate with the barrel, so
 * this is a loading saving as well as a deletion. */
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
  COVER_NAMES,
  DEVICE_LOCAL_FIELDS,
  parseCoverFacts,
  MAX_RECORD_FIELD,
  MAX_RECORD_POSITION,
  TRASH_DIR,
  atomicWrite,
  folderOf,
  isContentHash,
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
export { META_SCHEMA } from './core/bookFolder'
export type { BookRecord, CoverFacts, CoverName, TagClock, TagClockEntry } from './core/bookFolder'
export { MAX_COVER_BYTES, createCoverFactsPass, measureCover, publishableCover } from './core/coverFacts'
export type { CoverFactsPass, CoverFs } from './core/coverFacts'
/* The work key (WI-21.3): what a book's declared `identifier` says about the
 * WORK, as one comparable string. Exported here rather than kept private
 * because "two devices derive the same key" is a claim about two PROCESSES,
 * and a host that cannot call it cannot check it. Pure string work — nothing
 * platform-bound joins the browser-safe subtree by this. */
export { sameWork, workKey } from './core/workKey'
export type { WorkKey, WorkKeyKind } from './core/workKey'
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
/* ⚠️ **`createGenerations` IS NOT RE-EXPORTED EITHER**, for the same reason and
   with the same module left in place: `ui/App.tsx` imports it directly, which
   is a kernel file reaching a kernel file, and no capability asks for it.
   Last-issued wins — two subsystems raced their own async results and each had
   grown a private counter; see `core/generations.ts`. */
export { MAX_APPENDED, MAX_APPENDED_SHARED, WriteQueueFull, writeQueue } from './core/writeQueue'
export type { WriteQueue } from './core/writeQueue'
/* The circle's own store lives beside `marks.json` and never inside it — see
   `circlePathIn`. The paths are the kernel's because the folder layout is. */
export {
  CIRCLE_DIR,
  OWN_SHELF_PATH,
  circleFolderIn,
  circlePathIn,
  personFolderIn,
  personShelfPathIn,
  OWN_LISTS_DIR,
  ownListPathIn,
  personListsDirIn,
  personListPathIn,
  relationshipPathIn,
  publicPathIn,
  sharedPathIn,
  PUBLIC_DIR,
  VOICE_DECISIONS_PATH,
} from './core/bookFolder'
/* Public sharing — phase 25. Pure, browser-safe, and deliberately NOT under
   `circle/`: public and circle share no authorization and no storage, and a
   module that sat beside the circle's would be the first place that blurs. */
export {
  adopts,
  folderForFetch,
  mayAdoptIdentity,
  mayPublishNotes,
  offerAbsentBecause,
  offerabilityOf,
  planShareImport,
} from './core/publicShare'
export type { AdoptionVerdict, HeldBook, Offerable, PublicOfferability, ShareImport } from './core/publicShare'
/* Phase 26 — public annotations. Pure, browser-safe, and under `core/public/`
   rather than `core/circle/`: they share no authorization, no storage and no
   wire type, and a module sitting beside the circle's is the first place that
   blurs. The crypto is INJECTED for `page.ts`'s reason. */
export {
  DEFAULT_LIFETIME_MS,
  MAX_CLOCK_SKEW_MS,
  MAX_ENVELOPE_BYTES,
  MAX_LIFETIME_MS,
  byteLengthOf,
  PUBLIC_OPS,
  PUBLIC_SUPPORTED,
  PUBLIC_VERSION,
  isPublicEnvelopeShape,
  mintNote,
  mintPublicationId,
  mintUnnote,
  publicSignedBytes,
  readPublicEnvelope,
  sealPublic,
} from './core/public/envelope'
export type { Minting, PublicCrypto, PublicEnvelope, PublicPassage, PublicRefusal, Unsealed, Unsigned } from './core/public/envelope'
export {
  EMPTY_PUBLIC_FILE,
  comparePublic,
  foldPublic,
  publicationKey,
  sequenceKey,
} from './core/public/order'
export type { Delivered, KeptEnvelope, PublicFile, PublicHeld, PublicWithdrawal } from './core/public/order'
export {
  PUBLIC_DISCLOSURE,
  PUBLIC_LINKS_DISCLOSURE,
  disclosureFor,
  linksVoiceToPerson,
  mayPublish,
} from './core/public/publish'
export type { Audience, PublishRefusal, PublishRequest } from './core/public/publish'
export {
  NO_DECISIONS,
  bind,
  blockPerson,
  blockVoice,
  isWellFormed,
  personOf,
  standingOf,
  unbind,
  unblockPerson,
  unblockVoice,
  voicesOf,
} from './core/public/binding'
export type { BindingRefusal, VoiceBinding, VoiceDecisions, VoiceStanding } from './core/public/binding'
export { PUBLIC_WEIGHT, reconcile } from './core/public/presentation'
export type { AnchorWeight, Contributor } from './core/public/presentation'
export {
  ANCHOR_PER_TASK,
  DEFAULT_PUBLIC_BOUNDS,
  MAX_BOOKS_WITH_PUBLIC,
  MAX_HELD_BYTES_PER_BOOK,
  MAX_HELD_PER_BOOK,
  MAX_TASK_MS,
  VERIFY_PER_TASK,
  admitsAnotherBook,
  hasRoom,
  keepWithin,
  sizeOf,
  sliceFor,
} from './core/public/bounds'
export type { PublicBounds, Weighed } from './core/public/bounds'
export type { ForeignAnnotation, ForeignEntry, ForeignOpinion, OverlayAudience } from './core/circle/foreign'
/* The overlay seam's vocabulary — a capability implementing one needs to name
   the request it is handed and the resolver inside it. */
export type {
  OverlayContribution,
  OverlayRequest,
  PendingPassage,
  ResolvedPassage,
  ResolvePort,
  ResolveResult,
} from './core/circle/overlay'
export {
  drawable,
  foreignWeight,
  readersAmong,
  offersShare,
  offersUnshare,
  overlayKey,
  overlayKeyOf,
  shareAbsentBecause,
} from './core/circle/foreign'
export type { Publishability } from './core/circle/foreign'
/* The page protocol. Pure, and deliberately so — the crypto is INJECTED, which
   is what keeps `page.ts` inside `check-browser-safe.mjs`'s pinned set while
   the Ed25519 that satisfies it lives in a capability. */
export {
  MAX_ENTRIES_PER_PAGE,
  MAX_PAGE_CHARS,
  MAX_ROSTER_DEVICES,
  SUPPORTED,
  WIRE_VERSION,
  carriedBy,
  chainHash,
  checkPage,
  integersOnly,
  isCanonical,
  isEntryShape,
  isPageShape,
  negotiate,
  paginate,
  signedBytes,
} from './core/circle/page'
export type { Page, PageCrypto, PageRefusal, SignedKind, VersionRange } from './core/circle/page'
/* The log a page carries, and the fold that turns one into what is held. */
export { READING_STATES, STARS, compacted, compareEntries, fold, mergeLogs, nextSeq, resolved } from './core/circle/log'
export type {
  Entry,
  Folded,
  Held,
  HeldReview,
  HeldWork,
  Passage,
  ReadingState,
  Register,
  ShelvedWork,
  Stars,
} from './core/circle/log'
/* What a book is called when two libraries have to agree it is the same book.
   Never a hash of the file — `wire.md` §"`workKey` cannot be the log key". */
export { LIST_ID, MAX_CLAIM_DIGESTS, SHELF_WORK, claimFor, indexKeys, isClaimShape, listIdOf, listWork, logOfClaim, matchWork, primaryLanguage } from './core/circle/workClaim'
export type { ClaimSource, WorkClaim, WorkMatch } from './core/circle/workClaim'
/* A list's log, folded — WI-23.E1. */
export { NO_LIST, compactedList, compareItems, foldList } from './core/circle/list'
export type { ListItem, ListState } from './core/circle/list'
/* The bound that runs BEFORE a page is parsed, and the states it reads. */
export { BLOCKED_BUDGET, DEFAULT_BUDGET, NOTHING_SPENT, charge, readRouting } from './core/circle/bound'
export type { Budget, Charge, Routing, Spend } from './core/circle/bound'
export {
  acceptsTransport,
  admits,
  budgetFor,
  changeState,
  drawsEntry,
  drawsOverlays,
  mergeRelationship,
  FIRST_EPOCH,
  newRelationship,
  readmit,
  showShelf,
} from './core/circle/relationships'
export type { Relationship, RelationshipState, Retain } from './core/circle/relationships'
/* Whether the device that signed a page may still speak for its person. */
export { SKEW_MS, checkDelegation, maySpeak, shouldRenew, type Liveness } from './core/circle/identity'
export type { Delegation as CircleDelegation } from './core/circle/identity'
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
export type { TrashFs } from './core/bookTrash'
/* The trash's listing, for a capability that must reach a person's files in a trashed book's folder too — `purgePerson`. */
export { listTrash } from './core/bookTrash'
export type { ContentExtension, KnownExtension, SyncLevel, VaultFs } from './core/bookVault'
/* HOW A BOOK'S BYTES COME OFF THIS DEVICE'S OWN DISK — the four the phone's
   reader needs to answer `RemoteContent` locally, where the browser client
   answers the same contract over a WebSocket.
   `readRangeOf` rather than a caller's own `readRange ?? readFile-and-slice`
   for the reason its docstring gives: one place decides the bounds, and a
   second copy gets the last chunk of a large book subtly wrong. */
export { readOwnedBook, readRangeOf, storedBookName } from './core/bookVault'
export { contentPathIn } from './core/bookFolder'

/* ONE canonical serialisation, shared by sync's registers and the circle's
   signed bytes. In `core/` because a capability cannot import another's
   internals — see the module header. */
export { canonicalJson } from './core/canonicalJson'

/* The vocabulary. */
/* THE CLOSED DOMAINS, exported so a client can VALIDATE a wire row against
 * them rather than casting. Reading somebody else's JSON and trusting `kind`
 * to be one of three strings is how an unknown value reaches a switch with no
 * case for it — see `app/web/wireRow.ts`. */
export {
  boundedMark,
  isPlaced,
  placedIn,
  unplacedIn,
  MARK_KINDS,
  MARK_STYLES,
  MARK_TINTS,
  createMark,
  isAnnotation,
  isBookmark,
  liveMarks,
  markStamp,
  mergeMarks,
  validMarks,
} from './core/marks'
export type {
  Annotation,
  Bookmark,
  Highlight,
  Mark,
  MarkKind,
  MarkStorage,
  MarkStyle,
  MarkTint,
  NewMark,
  /* WI-22.A1's narrowing, beside the predicate that produces it: a client that
   * paints has to be able to NAME the class `isPlaced` answers, or it can only
   * widen back to `Annotation` and lose the guarantee at its own boundary. */
  Placed,
} from './core/marks'
/* The brand itself, so a client can spell the painter's door. From `core/`,
 * which is where it is declared — it used to be re-exported through the reader,
 * whose module imports foliate's CFI parser. */
export type { ResolvedCfi } from './core/resolvedCfi'
export { CARD_KINDS, CARDS_STORAGE_KEY, cardStamp, liveCards, mergeCards, parseCards } from './core/cards'
export type { Card, CardKind, NewCard } from './core/cards'
/* `paneOffered` and its list are the rule for whether a reader may see a panel
   at all — `composition.contract.test.ts` holds `KERNEL_DEFAULT_PANE` to it, so
   the kernel's fallback cannot drift back onto a panel nobody is shown. */
export {
  KERNEL_PANE_IDS,
  UNFINISHED_PANE_IDS,
  isContributedPaneId,
  isKernelPaneId,
  paneOffered,
} from './core/uiTypes'
export type { ContributedPaneId, KernelPaneId, PageLayout, PaneId, Screen, Side, Theme, Typeface } from './core/uiTypes'


/* The design system's icon sizes, and the list view's jacket. Exported for a
 * capability's UI: `lucide` takes a number, and a capability picking its own
 * would be the one control in the app drawn at a size nothing else uses.
 * `ICON.control` is the size every icon inside a control already takes.
 *
 * `LIST_COL` and `COVER_ASPECT` are here for the same reason one step further
 * out: a capability that draws a book's jacket in a row — the circle's roster
 * does — has to size it, and `RosterSection` wrote `24×36` on its `<img>`,
 * which is 2:3 done by hand next to the two constants that say it. The shelf's
 * own list draws a 22px thumb at `COVER_ASPECT`; a jacket in a capability's row
 * is the same object and should be the same size. */
export { COVER_ASPECT, ICON, LIST_COL } from './core/metrics'

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

/* THE SHELF CHANNEL — that same envelope over a WebSocket.
 *
 * The transport half of what the block above frames. It moved out of
 * `src/app/web/` in WI-11.7 for the reason the envelope moved out of `peer`:
 * a second caller appeared that could not reach where it lived. Here the
 * caller is `paper --shelf`, which imports through this entry and nothing
 * else of the kernel; the browser client keeps a re-export at its old path. */
export { connect as connectToShelf, socketUrl } from './core/shelfChannel'
export type { ClosedReason, ConnectOptions, ShelfChannel, SocketLike } from './core/shelfChannel'
