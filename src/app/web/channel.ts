/**
 * Where the browser client's channel used to live (moved WI-11.7).
 *
 * The transport is `src/kernel/core/shelfChannel.ts` now, because a second
 * caller with no DOM — `paper --shelf` — cannot import the browser client.
 * This re-export is why none of that client's seventeen importers had to
 * change, and it mirrors `capabilities/peer/lib/envelope.ts`, which did the
 * same job when the envelope moved for the same reason.
 *
 * ⚠️ It re-exports the LEAF, not the kernel's public entry. Going through the
 * barrel would pull every one of its re-exports into the web bundle to reach
 * one module — the cost `src/kernel/ui/browser.ts`'s own note measures at half
 * a percent of function coverage for ten unused surfaces.
 */
export { connect, socketUrl } from '../../kernel/core/shelfChannel'
export type { ClosedReason, ConnectOptions, ShelfChannel, SocketLike } from '../../kernel/core/shelfChannel'
