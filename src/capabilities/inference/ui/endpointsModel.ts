import { createGenerations } from '../../../kernel'
import type { ReportFailure } from '../lib/controller'
import type { Endpoint, InferencePlugin } from '../lib/plugin'

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
  /** Blank means "leave the stored key alone" — see the module header. */
  readonly key: string
}

export const EMPTY_DRAFT: EndpointDraft = { id: '', label: '', baseUrl: '', key: '' }

/** What a row's button does. */
export type EndpointAction = 'remove' | 'confirm'

export interface EndpointRow {
  readonly id: string
  readonly label: string
  /** The row's right-hand value: the host, and whether a key is stored. */
  readonly value: string
  readonly hasKey: boolean
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
}

/* --------------------------- what a draft refuses ------------------------ */

/**
 * ⚠️ **THE CRATE REMAINS THE AUTHORITY.** These rules mirror `valid_id` and
 * `valid_base_url` in `endpoints.rs`, and they exist so a reader is told what
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

export function validId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_ID && /^[a-z0-9-]+$/.test(id)
}

export function validBaseUrl(url: string): boolean {
  const scheme = 'https://'
  if (!url.startsWith(scheme) || url.length > MAX_BASE_URL) return false
  /* No whitespace or control characters anywhere: they cannot appear in a URL
     unescaped, and a header built from one would be split by them. */
  if (/[\s\p{Cc}]/u.test(url)) return false
  const rest = url.slice(scheme.length)
  /* No credentials, and no fragment — a base URL is a prefix Paper appends a
     route to, and `#` would make everything after it part of the fragment. */
  if (rest.includes('@') || rest.includes('#')) return false
  const authority = rest.split(/[/?]/)[0] ?? ''
  /* There has to BE a host: an empty authority is `https://` wearing a URL's
     clothes, and it reaches the daemon as a registration that cannot resolve. */
  return authority.length > 0 && /^[A-Za-z0-9.:-]+$/.test(authority) && /[A-Za-z0-9]/.test(authority)
}

/** Why this draft cannot be saved, in the reader's words, or null. */
export function refuseDraft(draft: EndpointDraft): string | null {
  if (draft.id === '') return 'Give the endpoint a name to refer to it by.'
  if (!validId(draft.id)) {
    return `A name is lower-case letters, digits and hyphens, up to ${MAX_ID} characters.`
  }
  if (draft.baseUrl === '') return 'Give the endpoint its address.'
  if (!validBaseUrl(draft.baseUrl)) {
    return 'An address is an https:// URL with a host, and no credentials in it.'
  }
  return null
}

/* ------------------------------- the row --------------------------------- */

/** The host an address points at, for the row's value. */
export function hostOf(baseUrl: string): string {
  const rest = baseUrl.replace(/^https:\/\//, '')
  return rest.split(/[/?]/)[0] ?? baseUrl
}

/** Turn one stored endpoint into a row. */
export function rowFor(endpoint: Endpoint, arming: string | null): EndpointRow {
  return {
    id: endpoint.id,
    label: endpoint.label === '' ? endpoint.id : endpoint.label,
    /* WHETHER A KEY IS STORED, never the key — there is deliberately no
       command that reads one back, and a row showing one is the easiest place
       for that absence to be quietly undone. */
    value: `${hostOf(endpoint.baseUrl)} · ${endpoint.hasKey ? 'key set' : 'no key'}`,
    hasKey: endpoint.hasKey,
    action: endpoint.id === arming ? 'confirm' : 'remove',
  }
}

/* ------------------------------ the store -------------------------------- */

export interface EndpointsModel {
  getSnapshot(): EndpointsSnapshot
  subscribe(listener: () => void): () => void
  refresh(): Promise<void>
  /**
   * Add or replace an endpoint, and set its key when one was typed.
   *
   * False when the draft was refused or a command failed; the reason is in
   * `snapshot.failure` either way.
   */
  save(draft: EndpointDraft): Promise<boolean>
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

const EMPTY: EndpointsSnapshot = { rows: [], loading: true, busy: false, failure: null }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createEndpointsModel({ plugin, report }: EndpointsModelOptions): EndpointsModel {
  const listeners = new Set<() => void>()
  let stored: readonly Endpoint[] | null = null
  let arming: string | null = null
  let busy = false
  let failure: string | null = null
  let cached: EndpointsSnapshot | null = EMPTY
  let disposed = false
  /* LAST ISSUED WINS. Every mutation re-reads and the pane reads on mount, so
     two are in flight the moment a reader saves while one is already out. */
  const generations = createGenerations()

  const invalidate = (): void => {
    cached = null
    for (const listener of [...listeners]) listener()
  }

  const build = (): EndpointsSnapshot =>
    stored === null
      ? { ...EMPTY, busy, failure }
      : { rows: stored.map((one) => rowFor(one, arming)), loading: false, busy, failure }

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

    save: async (draft) => {
      const refusal = refuseDraft(draft)
      if (refusal !== null) {
        failure = refusal
        invalidate()
        return false
      }
      /* AN ARMED REMOVAL IS TAKEN BACK: the reader has plainly moved on, and a
         press left armed is one click away from deleting something they are no
         longer looking at. */
      arming = null
      return mutate('inference.add-endpoint-failed', 'That endpoint could not be saved.', async () => {
        await plugin.addEndpoint(draft.id, draft.label === '' ? draft.id : draft.label, draft.baseUrl)
        /* BLANK MEANS LEAVE IT ALONE — `set_key("")` clears, which would take
           the key off an endpoint the reader was only relabelling. */
        if (draft.key !== '') await plugin.setEndpointKey(draft.id, draft.key)
      })
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
      disposed = true
      generations.claim()
      listeners.clear()
    },
  }
}
