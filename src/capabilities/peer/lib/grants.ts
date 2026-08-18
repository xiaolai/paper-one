/**
 * The grant rule, once — shared by the port's cached check and the fake
 * wire, and matching the plugin's (`peers.rs`): a grant is covered by its
 * exact spelling, or by `<prefix>:*` where the prefix is everything before
 * the first colon. A bare `*` covers nothing, and `sync:*` does not cover
 * `sync` itself — a wildcard names a family, not a word.
 */
export function grantCovers(grants: readonly string[], grant: string): boolean {
  if (grants.includes(grant)) return true
  const colon = grant.indexOf(':')
  if (colon <= 0) return false
  return grants.includes(`${grant.slice(0, colon)}:*`)
}
