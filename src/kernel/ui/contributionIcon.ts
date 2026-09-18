import { Globe, Users } from 'lucide-react'
import type { ContributionIcon } from '../core/capability'

/**
 * The glyph a contribution's icon NAME is drawn as — the design system's half
 * of `ContributionIcon`.
 *
 * ⚠️ **BOTH SURFACES DREW A PUZZLE PIECE, AND TWO CONTRIBUTIONS SHIP.**
 * `SidePane` hardcoded `Icon: Puzzle` for every contributed pane and `TitleBar`
 * did the same for every contributed screen, so **Circle** and **Publish** were
 * two identical icons beside each other in the reader's rail — and a jigsaw
 * piece says "a plugin goes here", which is architecture rather than anything a
 * reader is doing. Found in a screenshot, not by a test: nothing was wrong
 * enough to fail, it just could not be read.
 *
 * HERE RATHER THAN IN `panes.ts`, which is where the kernel's other pane
 * registry lives, because that module's own header refuses it: *"Icons are NOT
 * here. They are components from an icon package, and a module this low has no
 * business importing one."* It is also on the browser-safe pinned list, and
 * this module's two imports have no business crossing that line either. So the
 * rail and the titlebar share this, and nothing lower sees it.
 *
 * ⚠️ **THE RECORD IS TOTAL AND THERE IS NO FALLBACK.** The map is typed over
 * every member of `ContributionIcon`, so adding a name without a glyph is a
 * compile error and a glyph with no name is another — which is the whole point,
 * since a default glyph is exactly what let two panes share one drawing. Do not
 * give this an index signature or a `?? Puzzle`.
 */
export const CONTRIBUTION_ICONS: Record<ContributionIcon, typeof Users> = {
  people: Users,
  globe: Globe,
}
