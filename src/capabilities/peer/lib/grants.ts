/**
 * The grant rule, as this capability's modules reach it.
 *
 * THE RULE ITSELF MOVED to the kernel in phase 11 (`serviceTable.ts`), beside
 * the grants it governs, when the CLI's in-process caller became its third
 * consumer — after the port's cached check and the fake wire, and alongside
 * the plugin's own copy in `peers.rs`. Three hand-kept copies of a rule that
 * decides what a peer may do is three chances for one of them to be wrong,
 * and the wrong one would be wrong silently in the permissive direction.
 *
 * This file stays as the re-export so nothing under `peer/` changed its
 * imports, and so a reader who comes looking for the rule here finds where it
 * went rather than an absence.
 */
export { grantCovers } from '../../../kernel'
