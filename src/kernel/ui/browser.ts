/**
 * The kernel's UI entry FOR A BROWSER — the React surfaces a client served over
 * HTTP may mount (phase 19).
 *
 * ## Why a third door
 *
 * `src/kernel/index.ts` is React-free by design: it is what a capability's
 * declarations compile against. `src/kernel/ui/index.ts` renders React but is
 * Tauri-bound on purpose — it exports `App`, `libraryFs`, `openAppStorage` and
 * `tauriSizePort`, which is exactly what a composition root needs and exactly
 * what a browser cannot have.
 *
 * The browser client needs the middle: React, no platform. It had been reaching
 * past both entries into `ui/reader/FoliateView` by path, under a bespoke
 * dependency-cruiser rule (`web-client-kernel-allowlist`) that named five
 * modules it was allowed to touch — one of them the whole `ui/reader/`
 * DIRECTORY. That rule existed because the public entry was not browser-safe.
 * **It is now** — WI-19.1 — so the exemption became a door, and a directory
 * prefix became a list.
 *
 * ## ⚠️ THIS DOOR GROWS ONE EXPORT AT A TIME, WITH ITS WIRING
 *
 * The first draft exported ten surfaces nobody mounted yet — every pane and
 * every piece of reader furniture that happened to be browser-safe — on the
 * reasoning that a door costs nothing until something walks through it.
 *
 * **That is false for an ESM barrel, and it was measured.** A re-export is
 * evaluated when the barrel is, so importing `FoliateView` from here loaded all
 * ten; under test that dropped function coverage from 82% to 81.52% and failed
 * `pnpm verify`. Vite tree-shakes the shipped bundle, so the cost is not in
 * what a phone downloads — it is in the module graph everything else reasons
 * about, which is precisely what an entry is supposed to make legible.
 *
 * So: **add an export in the same change that mounts it.** A surface listed
 * here and used nowhere is speculative generality with a measurable price, and
 * `vitest.config.ts` is explicit that the threshold must not absorb it —
 * "slack is what let it flatter".
 *
 * Browser-safety is not a matter of care: `scripts/check-browser-safe.mjs`
 * PINS this file, so a platform-bound export fails `pnpm verify` in
 * milliseconds rather than being discovered by a bundle that will not build.
 *
 * ## Stylesheets are NOT imported here
 *
 * `ui/index.ts` pulls `tokens.css`, `global.css` and `capability.css` in as a
 * side effect so a root's reader "arrives dressed". This entry deliberately
 * does not: the browser client imports those itself, in `main.web.tsx`, beside
 * its own `applyMetrics` call — and a side-effect import here would make the
 * order of two stylesheet systems depend on which module was reached first.
 */

/* THE READING SURFACE. The same component the desktop mounts, which is the
 * whole reason the browser client is a reader and not a second reader. */
export { FoliateView } from './reader/FoliateView'

/* THE SHELF (WI-19.7). Freed by making `BookCover` take its jacket source as a
 * prop instead of importing `tauriVaultFs` — one import that had put
 * virtualisation, search, tag chips and sort out of a browser's reach. */
export { Library } from './screens/Library'

/* THE TABLE OF CONTENTS (WI-19.9). Sixty-one lines, one module in its closure,
 * and no service behind it — the cheapest of the six browser-safe panes, which
 * is why it is the first to come through this door. */
export { Contents } from './pane/Contents'

/* SEARCH WITHIN THE BOOK. Its prop was narrowed from `Book` — two dozen members
 * covering a whole reading session — to the five fields it actually reads, so a
 * client with a navigator and no session can mount it. */
export { SearchPanel } from './pane/SearchPanel'
export type { SearchableBook } from './pane/SearchPanel'
/* The metadata a client must hold to say a book has finished parsing. */
export type { BookMeta } from '../core/bookMeta'
/* A hit `SearchableBook.search` yields. */
export type { SearchHit } from './hooks/useBook'
/* What the reader reports when text is selected, and what it draws a mark from. */
export type { MarkAnchor, SelectionSnapshot } from './reader/session'

/* NOTES — every mark on the shelf, browsable. Its `marks` prop was narrowed
 * from `MarksView` (fourteen members, a whole `MarkStorage` behind them) to the
 * six it reads, so a host with a channel and `mark.list` can mount it. */
export { Marginalia } from './pane/Marginalia'

/* THE READER'S PREFERENCES. Seven of its setters are optional, so a host draws
 * only the rows it can act on — this client has no ruler, no side pane and no
 * scroll port of its own. `offeredFaces`/`presentFaces` come with it because
 * the pane cannot offer a typeface without knowing which are installed. */
export { Settings } from './pane/Settings'
export { offeredFaces } from '../core/typefaces'
export { presentFaces } from './fontProbe'

/* THE APP'S OWN COLOURS. Without it a reader who picks Night gets a dark book
 * inside light chrome — the setting half-applied, which reads as broken rather
 * than as a choice. */
export { useAppPalette } from './hooks/useAppPalette'

/* THE SHEET PRIMITIVE. A browser sheet needs exactly the two behaviours this
 * gets right — focus in and back out, in the right order, and inert siblings —
 * and only its desktop geometry wrong. `app/web/shell/BottomSheet` overrides
 * the geometry by attribute and reuses the rest. */
export { OverlaySheet } from './overlays/OverlaySheet'

/* THE DECK. Its `cards` prop was narrowed to the three members it reads, so a
 * host with `card.list` and no `CardStorage` can mount it. */
export { Cards } from './pane/Cards'

/* A jacket, or its tint. Takes its source as a prop — see the component. */
export { BookCover } from './screens/BookCover'
export type { CoverSource } from '../core/coverArt'

/* FOLLOWING THE OS COLOUR SCHEME. Design system §05 makes this the default, and
 * the browser client shipped the SETTING without the behaviour: `themeFollowsOs`
 * was stored, read, and never consulted, so the row a reader turns on did
 * nothing at all. The desktop has subscribed to `prefers-color-scheme` through
 * this hook since §05 landed; the same one is used here rather than a second
 * `matchMedia` that can disagree with it. */
export { usePrefersDark } from './platform'
