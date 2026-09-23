/**
 * The samples an engine hands back, turned into something the browser plays.
 *
 * The engines answer 16-bit mono PCM, little-endian, because that is the one
 * shape every part of this already speaks: `narrate/wav.rs` accepts it, the
 * audiobook packer writes it, and it crosses the IPC as bytes rather than as a
 * JSON number per sample.
 *
 * ⚠️ **NOTHING HERE TOUCHES `AudioContext`**, deliberately. Decoding is
 * arithmetic and belongs where it can be tested without a browser; the context
 * lives in `enginePlayer.ts`, which is the only file that needs one.
 */

/** How many samples a block of 16-bit PCM holds. */
export function sampleCount(pcm: Uint8Array): number {
  // A trailing odd byte is half a sample and cannot be played; it is dropped
  // rather than read past the end, which is what a bare `length / 2` would do
  // on a truncated transfer.
  return Math.floor(pcm.length / 2)
}

/**
 * Read 16-bit little-endian samples into the floats WebAudio wants.
 *
 * Divided by 32768 rather than 32767: that is the magnitude of the most
 * negative sample, so the whole range maps inside [-1, 1) and nothing clips on
 * the way in. The engines clamp to ±32767 when they write, so the asymmetry
 * costs a value no engine produces.
 */
export function toFloats(pcm: Uint8Array): Float32Array {
  const count = sampleCount(pcm)
  const out = new Float32Array(count)
  // A view over the SAME buffer, at the right offset: `pcm` may be a slice of
  // a larger transfer, and reading its `buffer` from 0 would read somebody
  // else's bytes.
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2)
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

/** How long a block of samples lasts, in milliseconds. */
export function durationMs(pcm: Uint8Array, sampleRate: number): number {
  if (sampleRate <= 0 || !Number.isFinite(sampleRate)) return 0
  return (sampleCount(pcm) / sampleRate) * 1000
}

/**
 * Whether a block is audible at all, or silence of the right length.
 *
 * ⚠️ **THE FAILURE THIS NAMES IS THE ONE NOBODY HEARS UNTIL THEY PLAY IT.** A
 * render that produced a correctly-sized block of zeroes is indistinguishable
 * from a working one by every other measure — its length is right, its word
 * timings are right, and the reading reports that it finished. The engines
 * refuse an empty render on their own side; this is the check at the other end
 * of the wire, where a transfer that dropped its payload arrives.
 *
 * Sampled rather than scanned: a minute of audio is a million samples, and a
 * render that is silent is silent everywhere. 512 evenly-spaced samples find
 * any real speech, and cost nothing on the main thread.
 */
export function audible(pcm: Uint8Array, threshold = 32): boolean {
  const count = sampleCount(pcm)
  if (count === 0) return false
  const view = new DataView(pcm.buffer, pcm.byteOffset, count * 2)
  const step = Math.max(1, Math.floor(count / 512))
  for (let i = 0; i < count; i += step) {
    if (Math.abs(view.getInt16(i * 2, true)) > threshold) return true
  }
  return false
}
