/**
 * The envelope, which now lives in the kernel.
 *
 * It was written here because `peer` was its first caller, and nothing about it
 * is peer-to-peer — it is request/response framing over any ordered byte
 * stream. Phase 18 gave it a second transport and the misplacement started to
 * cost: the browser client cannot import from this capability at all, because
 * `index.ts` reaches `@tauri-apps` and a browser has no such thing.
 *
 * This file stays as a re-export so nothing inside `peer` had to move with it.
 * A shim rather than a rewrite of eight import lines: the point of the change
 * was the envelope's HOME, and churning every caller would have buried that in
 * a diff about paths.
 */
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
} from '../../../kernel'
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
} from '../../../kernel'
