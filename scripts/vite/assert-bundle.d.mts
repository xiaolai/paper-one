/**
 * Types for `assert-bundle.mjs`, so `vite.config.ts` (checked by
 * `tsconfig.node.json`) sees the plugin's surface. Kept beside the module,
 * by hand: the plugin is plain JavaScript like the rest of `scripts/`, so it
 * runs under `node` and under Vitest without a compile step, and this file
 * is the only thing TypeScript needs from it. `scripts/assert-bundle.test.mjs`
 * exercises the real module.
 */
import type { Plugin } from 'vite'

export type Platform = 'desktop' | 'ios' | 'android'

export const VIRTUAL_ID: 'virtual:paper-composition'
export const PLUGIN_NAME: 'paper:composition'
export const MANIFEST_NAME: 'capabilities.manifest.json'

export function selectPlatform(env?: NodeJS.ProcessEnv, explicit?: Platform): Platform
export function loadManifest(root: string): { capabilities: unknown[] }
export function bundleModuleIds(bundle: Record<string, { type: string; moduleIds?: readonly string[]; modules?: Record<string, unknown> }>): string[]
export function bundleRoots(root: string): string[]

export interface PaperCompositionOptions {
  /** Overrides the environment's `TAURI_ENV_PLATFORM`. */
  readonly platform?: Platform
  /** The environment to read; `process.env` by default. */
  readonly env?: NodeJS.ProcessEnv
  /** Receives the summary line; `console.log` by default. */
  readonly log?: (line: string) => void
}

export function paperComposition(options?: PaperCompositionOptions): Plugin
