import { messageOf, notifyAll } from '../../../kernel'
import { createGenerations } from '../../../kernel'
import type { ReportFailure } from '../lib/controller'
import type { Endpoint, InferencePlugin, KeyState } from '../lib/plugin'

/**
 * The **Cloud endpoints** section's decisions — no React, so they can be
 * tested.
 *
 * `EndpointsPane.tsx` draws what this decides, the same split
 * `modelsModel`/`ModelsPane` uses and for the same reason: the interesting
 * rules here are about what a row SAYS and what a draft REFUSES, and a rule
 * that can only be checked by rendering is a rule nobody checks.
 *
 * # One form that adds or replaces
 *
 * `endpoints.rs`'s `add` drops any record with the same id and pushes the new
 * one, and it does NOT touch the keychain. So re-submitting an id is an edit
 * that keeps the key, which is what makes "change the label" possible without
 * asking the reader to find their key again. The form is that operation, and
 * the hint says so rather than leaving it to be discovered.
 *
 * # A blank key is not an empty key
 *
 * `set_key("")` CLEARS — that is `endpoints.rs`'s own rule, so that a stored
 * empty string cannot make a row claim to be configured while
 * `keys_for_spawn` silently omits it. This model therefore does not call it
 * for a blank field: blank means "leave whatever is there", which is the only
 * reading that lets an edit keep its key. Clearing a key is removing the
 * endpoint, which also takes it out of the keychain — one operation, one
 * meaning.
 */

/** Only the four commands this section uses, of the plugin's nineteen. */
export type EndpointsPlugin = Pick<
  InferencePlugin,
  'endpoints' | 'addEndpoint' | 'removeEndpoint' | 'setEndpointKey'
>

/** What the reader typed into the form. */
export interface EndpointDraft {
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  /**
   * The model the endpoint is asked for, in the provider's own spelling —
   * `gpt-4.1-mini`, `deepseek-chat`, `qwen2.5:7b`. REQUIRED: an
   * OpenAI-compatible request names a model, and there is none Paper could
   * honestly guess for somebody else's server (`noModelName`).
   */
  readonly model: string
  /** Blank means "leave the stored key alone" — see the module header. */
  readonly key: string
}

export const EMPTY_DRAFT: EndpointDraft = { id: '', label: '', baseUrl: '', model: '', key: '' }

/** What a row's button does. */
export type EndpointAction = 'remove' | 'confirm'

export interface EndpointRow {
  readonly id: string
  readonly label: string
  /** The row's right-hand value: the host, and whether a key is stored. */
  readonly value: string
  readonly keyState: KeyState
  /**
   * `confirm` once Remove has been pressed and not yet acted on.
   *
   * TWO PRESSES, because this one is not recoverable. The models list removes
   * a download with a single press and that is right — the bytes come back
   * from the same URL. A key does not: Paper never reads one back, so it
   * cannot put one back, and a reader who no longer has it has lost access to
   * whatever they were paying for. There is no confirmation dialog in
   * `CAPABILITY_UI`, and a button that says what it is about to do is a
   * better answer than one anyway.
   */
  readonly action: EndpointAction
}

export interface EndpointsSnapshot {
  readonly rows: readonly EndpointRow[]
  readonly loading: boolean
  /** True while a save or a removal is in flight. */
  readonly busy: boolean
  /** What went wrong, in the reader's words, or null. */
  readonly failure: string | null
  /**
   * What the reader has typed into the form and not yet saved.
   *
   * ⚠️ **THIS WAS `useState` IN THE PANE, AND THE PANE DOES NOT SURVIVE THE
   * GROUP BEING CLOSED.** `PaneGroup` unmounts a closed group on purpose — a
   * contributed section must not keep running behind one nobody is looking at
   * — so a reader who pasted an address, opened another group to find their
   * key and came back met three empty fields. The model is what outlives the
   * mount, and every other thing the pane draws already lives here
   * (2026-09-13 audit, round 2).
   */
  readonly draft: EndpointDraft
}

/* --------------------------- what a draft refuses ------------------------ */

/**
 * ⚠️ **THE CRATE REMAINS THE AUTHORITY.** These rules mirror `valid_id`,
 * `valid_base_url` and `valid_model_name` in `endpoints.rs`, and they exist so a reader is told what
 * is wrong with what they typed — beside the field, in their own words —
 * rather than after a round trip, as a `ManifestMalformed` naming nothing they
 * can act on.
 *
 * Two validators for one rule is the shape that drifts, so
 * `endpointsModel.test.ts` asserts the direction that matters: **anything
 * these accept, the crate accepts.** A pre-check stricter than the authority
 * merely annoys; one that is laxer hands the reader an error from a process
 * away, which is what having no pre-check does anyway.
 */
const MAX_ID = 40
const MAX_BASE_URL = 400
/** `limits::MAX_ENDPOINT_MODEL`, in BYTES as the crate counts it. */
const MAX_MODEL = 200

/** A byte count as the crate takes one: UTF-8, not UTF-16 units. */
const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/**
 * The three spellings of THIS MACHINE that earn plain `http://`, each with an
 * optional port — `is_loopback_authority` in the crate. No DNS answer or hosts
 * file can send any of them elsewhere (`localhost` is reserved to the loopback),
 * which is the whole argument for letting a key travel unencrypted to it:
 * Ollama and LM Studio serve on one of these and speak no TLS.
 */
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/

export function validId(id: string): boolean {
  /* The pattern's `+` is the crate's `!id.is_empty()`: a separate length test
     beside it could never be the one that refused. */
  return id.length <= MAX_ID && /^[a-z0-9-]+$/.test(id)
}

export function validBaseUrl(url: string): boolean {
  /* ⚠️ **`http://` IS ALLOWED, AND ONLY TO THIS MACHINE.** Everything else is
     `https://` or nothing: an endpoint's key rides in a header, and a key sent
     in the clear to another host is a key given away. The one exception is a
     server on the loopback — Ollama, LM Studio — where there is no wire to
     read it from (the gloss routes contract, §3). */
  const loopback = url.startsWith('http://')
  /* BYTES, NOT CODE UNITS: the crate bounds `url.len()`, which is UTF-8 bytes,
     and `url.length` is UTF-16 units — a Unicode-heavy address passed here
     and was refused there. */
  if (!(url.startsWith('https://') || loopback) || bytesOf(url) > MAX_BASE_URL) return false
  /* No whitespace or control characters anywhere: they cannot appear in a URL
     unescaped, and a header built from one would be split by them. */
  if (/[\s\p{Cc}]/u.test(url)) return false
  const rest = url.slice(url.indexOf('://') + 3)
  /* No credentials, and no fragment — a base URL is a prefix Paper appends a
     route to, and `#` would make everything after it part of the fragment. */
  if (rest.includes('@') || rest.includes('#')) return false
  // Stryker disable next-line StringLiteral: `split` returns at least one part, so the fallback is never taken
  const authority = rest.split(/[/?]/)[0] ?? ''
  /* THE LOOPBACK BY NAME, and nothing that merely resolves there: `127.0.0.2`,
     `0.0.0.0` and `localhost.example.com` are all refused, as the crate
     refuses them. The platform parser still has the last word on the port. */
  if (loopback) return LOOPBACK.test(authority) && parses(url)
  /* There has to BE a host: an empty authority is `https://` wearing a URL's
     clothes, and it reaches the crate as an address that cannot resolve.
     The `+` refuses the empty one, as the crate's `!authority.is_empty()` does. */
  if (!(/^[A-Za-z0-9.:-]+$/.test(authority) && /[A-Za-z0-9]/.test(authority))) return false
  /* AND IT HAS TO BE A HOST. The character class let `a:99999`, `a..b` and
     `-host` through with the message promising a valid address; the platform
     parser knows what a host and a port are, and refuses those.

     No credential or bracket test follows it, and two stood here: `@` is
     refused above, so the parser never finds a user or a password, and `[` is
     outside the character class, so no IPv6 literal reaches the parser. An
     https URL that parses always has a host. */
  if (!parses(url)) return false
  const labels = new URL(url).hostname.split('.')
  if (labels.some((label) => label === '' || label.startsWith('-') || label.endsWith('-'))) return false
  return true
}

/** Whether the platform's URL parser takes the address at all — a port past 65535 it does not. */
function parses(url: string): boolean {
  try {
    new URL(url)
  } catch {
    return false
  }
  return true
}

/**
 * A model name as a provider spells it — `valid_model_name` in the crate. Any
 * printable characters, because providers use `/`, `:`, `.` and `@`; no
 * whitespace or control characters, because a stray newline in one is a paste
 * accident rather than a model; and bounded in BYTES, as the crate counts.
 */
export function validModelName(name: string): boolean {
  return name !== '' && bytesOf(name) <= MAX_MODEL && !/[\s\p{Cc}]/u.test(name)
}

/** Why this draft cannot be saved, in the reader's words, or null. */
export function refuseDraft(draft: EndpointDraft): string | null {
  if (draft.id === '') return 'Give the endpoint a name to refer to it by.'
  if (!validId(draft.id)) {
    return `A name is lower-case letters, digits and hyphens, up to ${MAX_ID} characters.`
  }
  if (draft.baseUrl === '') return 'Give the endpoint its address.'
  if (!validBaseUrl(draft.baseUrl)) {
    return 'An address is an https:// URL with a host and no credentials in it — or http:// to this computer (localhost).'
  }
  if (draft.model === '') return 'Give the name of the model to ask for — the provider’s own, like gpt-4.1-mini.'
  if (!validModelName(draft.model)) {
    return `A model name has no spaces in it, and is at most ${MAX_MODEL} characters.`
  }
  return null
}

/* ------------------------------- the row --------------------------------- */

/** What the row says about the key, per state — and never the key. */
const KEY_STATE_WORDS: Readonly<Record<KeyState, string>> = {
  set: 'key set',
  missing: 'no key',
  unreadable: 'key unreadable',
}

/**
 * The host an address points at, for the row's value — and for the sentence
 * Look up says about where a word is sent (`glossRouteModel.whereTheWordsGo`).
 */
export function hostOf(baseUrl: string): string {
  // Stryker disable next-line Regex: every stored address begins with `https://` or `http://` (`valid_base_url`), and a replace with no `g` removes that first occurrence anchored or not
  const rest = baseUrl.replace(/^https?:\/\//, '')
  return rest.split(/[/?]/)[0] ?? baseUrl
}

/** Turn one stored endpoint into a row. */
export function rowFor(endpoint: Endpoint, arming: string | null): EndpointRow {
  return {
    id: endpoint.id,
    label: endpoint.label === '' ? endpoint.id : endpoint.label,
    /* WHETHER A KEY IS STORED, never the key — there is deliberately no
       command that reads one back, and a row showing one is the easiest place
       for that absence to be quietly undone. Three words for three states:
       "no key" on a key the keychain would not read sent the reader to
       re-enter a credential they already had. */
    /* THE MODEL BESIDE THE HOST, because two rows for one provider differ by
       nothing else — and an endpoint stored before the field existed says it
       has none, which is why its route cannot answer (`noModelName`). */
    value: `${hostOf(endpoint.baseUrl)} · ${endpoint.model === '' ? 'no model name' : endpoint.model} · ${KEY_STATE_WORDS[endpoint.keyState]}`,
    keyState: endpoint.keyState,
    action: endpoint.id === arming ? 'confirm' : 'remove',
  }
}

/* ------------------------------ the store -------------------------------- */

export interface EndpointsModel {
  getSnapshot(): EndpointsSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  /** Change one field of the unsaved draft — see `EndpointsSnapshot.draft`. */
  edit(field: keyof EndpointDraft, value: string): void
  /**
   * Add or replace the endpoint in the draft, and set its key when one was
   * typed.
   *
   * False when the draft was refused or a command failed; the reason is in
   * `snapshot.failure` either way.
   *
   * ⚠️ **IT TAKES NO DRAFT, AND THAT IS THE POINT.** The pane held the form in
   * `useState` and handed it in, so the draft was lost whenever the group
   * closed. Passing the model its own draft back would leave two copies of one
   * thing, which is the arrangement that drifts. **Cleared only on success**:
   * a refused draft stays in the fields so the reader corrects the one thing
   * that was wrong, rather than retyping an address and a key they have
   * already pasted once.
   */
  save(): Promise<boolean>
  /**
   * Press Remove on a row: arms it, or removes it if it was already armed.
   *
   * Arming one row disarms any other, so nothing is ever more than one press
   * away from exactly one deletion.
   */
  pressRemove(id: string): Promise<void>
  /** Take back an arming, when the reader plainly moved on. */
  disarm(): void
  dispose(): void
}

export interface EndpointsModelOptions {
  readonly plugin: EndpointsPlugin
  readonly report?: ReportFailure
}

const EMPTY: EndpointsSnapshot = { rows: [], loading: true, busy: false, failure: null, draft: EMPTY_DRAFT }


export function createEndpointsModel({ plugin, report }: EndpointsModelOptions): EndpointsModel {
  const listeners = new Set<() => void>()
  let stored: readonly Endpoint[] | null = null
  let arming: string | null = null
  let busy = false
  let failure: string | null = null
  let draft: EndpointDraft = EMPTY_DRAFT
  let cached: EndpointsSnapshot | null = EMPTY
  let disposed = false
  /* LAST ISSUED WINS. Every mutation re-reads and the pane reads on mount, so
     two are in flight the moment a reader saves while one is already out. */
  const generations = createGenerations()

  const invalidate = (): void => {
    cached = null
    notifyAll(listeners, 'endpoints')
  }

  const build = (): EndpointsSnapshot =>
    stored === null
      ? { ...EMPTY, busy, failure, draft }
      : { rows: stored.map((one) => rowFor(one, arming)), loading: false, busy, failure, draft }

  const read = async (): Promise<void> => {
    const mine = generations.claim()
    let found: readonly Endpoint[]
    try {
      found = await plugin.endpoints()
    } catch (error) {
      report?.('inference.endpoints-failed', { message: messageOf(error) })
      /* AN UNREADABLE LIST IS NOT AN EMPTY ONE. Saying "no endpoints" over a
         file that would not parse invites the reader to add a duplicate, and
         `endpoints.rs` refuses to treat a malformed file as empty for the
         same reason. */
      if (!mine() || disposed) return
      failure = 'The endpoint list could not be read.'
      invalidate()
      return
    }
    if (!mine() || disposed) return
    stored = found
    invalidate()
  }

  /** Run one mutation, reporting its failure and re-reading after it. */
  const mutate = async (event: string, said: string, run: () => Promise<void>): Promise<boolean> => {
    busy = true
    failure = null
    invalidate()
    try {
      await run()
    } catch (error) {
      report?.(event, { message: messageOf(error) })
      /* RESOLVES FALSE, DOES NOT REJECT — the pane calls these from a click
         handler, and a rejection there is an unhandled promise and a reader
         who is told nothing. The same contract the controller's install and
         uninstall have, for the same reason. */
      if (!disposed) {
        busy = false
        failure = said
        invalidate()
      }
      return false
    }
    await read()
    if (!disposed) {
      busy = false
      invalidate()
    }
    return true
  }

  return {
    getSnapshot: () => {
      if (cached === null) cached = build()
      return cached
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh: read,

    edit: (field, value) => {
      draft = { ...draft, [field]: value }
      invalidate()
    },

    save: async () => {
      /* READ ONCE, so what is SENT cannot change under the await if the reader
         goes on typing while the save is out. */
      const sending = draft
      const refusal = refuseDraft(sending)
      if (refusal !== null) {
        failure = refusal
        invalidate()
        return false
      }
      /* AN ARMED REMOVAL IS TAKEN BACK: the reader has plainly moved on, and a
         press left armed is one click away from deleting something they are no
         longer looking at. */
      arming = null
      const saved = await mutate('inference.add-endpoint-failed', 'That endpoint could not be saved.', async () => {
        await plugin.addEndpoint(sending.id, sending.label === '' ? sending.id : sending.label, sending.baseUrl, sending.model)
        /* BLANK MEANS LEAVE IT ALONE — `set_key("")` clears, which would take
           the key off an endpoint the reader was only relabelling. */
        if (sending.key !== '') await plugin.setEndpointKey(sending.id, sending.key)
      })
      /* CLEARED ONLY ON SUCCESS — a refused draft stays in the fields so the
         reader corrects the one thing that was wrong.

         ⚠️ **AND ONLY WHERE IT IS STILL THE DRAFT THAT WAS SENT.** A save is a
         round trip to the runtime, and a reader goes on typing across it — so
         clearing whatever was in the fields when it landed took away the NEXT
         endpoint they had begun (2026-09-13 verify). `edit` builds a new draft,
         so identity is the whole test. */
      if (saved && !disposed && draft === sending) {
        draft = EMPTY_DRAFT
        invalidate()
      }
      return saved
    },

    pressRemove: async (id) => {
      if (arming !== id) {
        arming = id
        failure = null
        invalidate()
        return
      }
      arming = null
      await mutate('inference.remove-endpoint-failed', 'That endpoint could not be removed.', () =>
        plugin.removeEndpoint(id),
      )
    },

    disarm: () => {
      if (arming === null) return
      arming = null
      invalidate()
    },

    dispose: () => {
      /* No generation is claimed here: every read tests `disposed` beside its
         generation, so a claim could only repeat what this flag already says. */
      disposed = true
      listeners.clear()
    },
  }
}
