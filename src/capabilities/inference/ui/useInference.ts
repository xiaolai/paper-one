import { useSyncExternalStore } from 'react'
import type { InferenceSnapshot, InferenceStore } from '../lib/controller'

/**
 * Subscribe a component to the inference controller.
 *
 * The `useSyncExternalStore` pair, exactly as `useSync` does it for the sync
 * capability: the store is not React's, and this is the adapter rather than a
 * second copy of the state.
 */
export function useInference(store: InferenceStore): InferenceSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
