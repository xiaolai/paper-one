/**
 * Base64 over bytes, for the cover a friend is served — WI-23.C5.
 *
 * The kernel's `content.read` and `cover.read` spell their chunks the same
 * way; this is the circle's own copy because the kernel keeps its encoder
 * beside its handlers rather than on its surface. Chunked on the way in so a
 * megabyte does not become a million-argument call.
 */

export function base64Of(bytes: Uint8Array): string {
  let text = ''
  // Stryker disable next-line EqualityOperator: one more turn appends the empty slice, which is nothing.
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}

/** The bytes a base64 text spells, or null for a text that is not base64 — checked before `atob` can throw on it. */
export function bytesOfBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return null
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  // Stryker disable next-line EqualityOperator: one more turn writes past the end of a typed array, which drops the write.
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}
