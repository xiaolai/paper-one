import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compare, parseAllowList, scan } from './check-residue.mjs'
import { isProcessEntry } from './lib/entry.mjs'

/**
 * `pnpm residue:selftest` — a gate nobody has watched fail is a comment.
 *
 * Builds a small kernel under a temporary root, plants one naming per case, and
 * runs the real scan and comparison over it. `scripts/check-residue.test.mjs`
 * runs the same cases under Vitest, which is what binds `pnpm verify` and what
 * puts them in the test ledger; this file is the standalone runner, as
 * `boundaries:selftest` is for its own.
 */

const IDS = ['circle', 'public', 'passages']
const ALLOWED = { id: 'circle', file: 'src/kernel/a.ts', match: './circle/log', count: 1, reason: 'held on purpose' }
const CLEAN = "export { a } from './circle/log'\n"

/** One naming of `passages` in `src/kernel/b.ts`, or of `circle` for the keys. */
const naming = (id, name, source, more = {}) => ({ name, files: { 'src/kernel/b.tsx': `${source}\n`, ...more }, rows: [ALLOWED], expect: [`NEW src/kernel/b.tsx [${id}]`] })
const refusal = (name, source, more = {}) => ({ name, files: { 'src/kernel/b.tsx': `${source}\n`, ...more }, rows: [ALLOWED], expect: ['NEW src/kernel/b.tsx [(unfollowed)]'] })
const quiet = (name, source, more = {}) => ({ name, files: { 'src/kernel/b.tsx': `${source}\n`, ...more }, rows: [ALLOWED], expect: [] })

const TYPE = "import type { KernelServices } from './core/services'\n"

const PLANTED = [
  // A type that is the services, however it says so.
  naming('passages', 'a planted local of an intersection with services', `${TYPE}export const f = (s: KernelServices & { x: 1 }) => s.passages`),
  naming('passages', 'a planted local of a parenthesised union', `${TYPE}export const f = (s: (KernelServices | undefined)) => s!.passages`),
  naming('passages', 'a planted local of a type parameter bound by services', `${TYPE}export const f = <T extends KernelServices>(s: T) => s.passages`),
  naming('passages', 'a planted local of a type alias', `${TYPE}type S = KernelServices\nexport const f = (s: S) => s.passages`),
  naming('passages', 'a planted local of an alias of an alias', `${TYPE}type S = KernelServices | null\ntype R = S\nexport const f = (s: R) => s!.passages`),
  naming('passages', 'a planted local of an interface extending services', `${TYPE}interface S extends KernelServices { x: 1 }\nexport const f = (s: S) => s.passages`),
  naming('passages', 'a planted local of a generic that keeps its argument', `${TYPE}type Local<T> = T | null\nexport const f = (s: Local<KernelServices>) => s!.passages`),
  naming('passages', 'a planted local of a generic interface extending its argument', `${TYPE}interface Local<T> extends Readonly<T> { x: 1 }\nexport const f = (s: Local<KernelServices>) => s.passages`),
  naming('passages', 'a planted local of a generic with services for a default', `${TYPE}type Local<T = KernelServices> = T | null\nexport const f = (s: Local) => s!.passages`),
  naming('passages', 'a planted local of a generic declared in another file', "import type { KernelServices } from './core/services'\nimport type { Local } from './types'\nexport const f = (s: Local<KernelServices>) => s!.passages", { 'src/kernel/types.ts': 'export type Local<T> = T | null\n' }),
  naming('passages', 'a planted local of an alias declared in another file', "import type { S } from './types'\nexport const f = (s: S) => s.passages", { 'src/kernel/types.ts': `${TYPE}export type S = KernelServices\n` }),
  naming('passages', 'a planted local of an alias renamed on import', "import type { S as R } from './types'\nexport const f = (s: R) => s.passages", { 'src/kernel/types.ts': `${TYPE}export type S = KernelServices\n` }),
  naming('passages', 'a planted local of the type renamed on import', "import type { KernelServices as K } from './core/services'\nexport const f = (s: K) => s.passages"),
  naming('passages', 'a planted local of the type re-exported under another name', "import type { K } from './types'\nexport const f = (s: K) => s.passages", { 'src/kernel/types.ts': "export type { KernelServices as K } from './core/services'\n" }),
  naming('passages', 'a planted local of the type by namespace', "import type * as Core from './core/services'\nexport const f = (s: Core.KernelServices) => s.passages"),
  naming('passages', 'a planted local of the type by an import type', "export const f = (s: import('./core/services').KernelServices) => s.passages"),
  naming('passages', 'a planted local of the type by an import assignment', "import type * as Core from './core/services'\nimport K = Core.KernelServices\nexport const f = (s: K) => s.passages"),
  naming('passages', 'a planted local of the type of the services', 'export const f = (env: any, s: typeof env.services) => s.passages'),
  naming('passages', 'a planted local of what a services function returns', "import type { createKernelServices } from './core/services'\nexport const f = (s: ReturnType<typeof createKernelServices>) => s.passages"),
  naming('passages', 'a planted promise of services, awaited', `${TYPE}export const f = async (p: Promise<KernelServices>) => (await p).passages`),
  naming('passages', 'a planted promise of services, then', `${TYPE}export const f = (p: Promise<KernelServices>) => p.then((s) => s.passages)`),
  naming('passages', 'a planted cast to services', `${TYPE}export const f = (x: unknown) => (x as KernelServices).passages`),
  naming('passages', 'a planted local of a type picked from an alias', `${TYPE}type S = KernelServices\nexport const f = (s: Pick<S, 'passages'>) => s.passages`),
  // In an array, and what the type says of one.
  naming('passages', 'a planted element of an array type', `${TYPE}export const f = (all: KernelServices[]) => all[0].passages`),
  naming('passages', 'a planted element of an Array', `${TYPE}export const f = (all: Array<KernelServices>) => all[0].passages`),
  naming('passages', 'a planted element of a readonly array', `${TYPE}export const f = (all: readonly KernelServices[]) => all[0].passages`),
  naming('passages', 'a planted element of a tuple', `${TYPE}export const f = (all: [KernelServices]) => all[0].passages`),
  naming('passages', 'a planted element of an array of a pick', `${TYPE}export const f = (all: Array<Pick<KernelServices, 'passages'>>) => all[0].passages`),
  naming('passages', 'a planted loop over an array type', `${TYPE}export const f = (all: KernelServices[]) => { for (const s of all) return s.passages }`),
  naming('passages', 'a planted callback over an array type', `${TYPE}export const f = (all: KernelServices[]) => all.map((s) => s.passages)`),
  naming('passages', 'a planted element of a named array', 'export const f = (env: any) => {\n  const all = [env.services]\n  return all[0].passages\n}'),
  naming('passages', 'a planted loop over a named array', 'export const f = (env: any) => {\n  const all = [env.services]\n  for (const s of all) return s.passages\n}'),
  naming('passages', 'a planted callback over a written array', 'export const f = (env: any) => [env.services].map((s) => s.passages)'),
  naming('passages', 'a planted rest parameter', 'const read = (...all: any[]) => all[0].passages\nexport const f = (env: any) => read(env.services)'),
  // In an object bound to a name.
  naming('passages', 'a planted key of a named object', 'export const f = (env: any) => {\n  const o = { s: env.services }\n  return o.s.passages\n}'),
  naming('passages', 'a planted literal lookup on a named object', "export const f = (env: any) => {\n  const o = { s: env.services }\n  return o['s'].passages\n}"),
  naming('passages', 'a planted pattern over a named object', 'export const f = (env: any) => {\n  const o = { s: env.services }\n  const { s } = o\n  return s.passages\n}'),
  naming('passages', 'a planted spread of services', 'export const f = (env: any) => {\n  const o = { ...env.services }\n  return o.passages\n}'),
  // Returned, and renamed.
  naming('passages', 'a planted call of a function ending in services', 'export const f = (getServices: any) => getServices().passages'),
  naming('passages', 'a planted call of a member ending in services', 'export const f = (env: any) => env.useServices().passages'),
  naming('passages', 'a planted function returning services in the file', 'export const f = (env: any) => {\n  const g = () => env.services\n  return g().passages\n}'),
  naming('passages', 'a planted function returning services by its annotation', `${TYPE}declare const g: () => KernelServices\nexport const f = () => g().passages`),
  naming('passages', 'a planted function declared to return services', `${TYPE}declare function g(): KernelServices\nexport const f = () => g().passages`),
  naming('passages', 'a planted parameter of an alias of a function returning services', `${TYPE}type Get = () => KernelServices\nexport const f = (g: Get) => g().passages`),
  naming('passages', 'a planted function handed the services and returning them', 'const id = (s: any) => s\nexport const f = (env: any) => id(env.services).passages'),
  naming('passages', 'a planted name for a function ending in services', 'export const f = (getServices: any) => {\n  const g = getServices\n  return g().passages\n}'),
  // A key that folds, and a read by reflection.
  naming('passages', 'a planted constant key', "const K = 'passages'\nexport const f = (env: any) => env.services[K]"),
  naming('passages', 'a planted joined key', "export const f = (env: any) => env.services['pass' + 'ages']"),
  naming('passages', 'a planted template key', "const K = 'pass'\nexport const f = (env: any) => env.services[`${K}ages`]"),
  naming('passages', 'a planted constant key in a pattern', "const K = 'passages'\nexport const f = (env: any) => {\n  const { [K]: p } = env.services\n  return p\n}"),
  naming('passages', 'a planted reflective read', "export const f = (env: any) => Reflect.get(env.services, 'passages')"),
  naming('passages', 'a planted in test', "export const f = (env: any) => 'passages' in env.services"),
  // Members of what is not a plain object.
  naming('circle', 'a planted class property', 'export class C { circle = 1 }'),
  naming('circle', 'a planted class method', 'export class C { circle() {} }'),
  naming('circle', 'a planted class getter', 'export class C { get circle() { return 1 } }'),
  naming('circle', 'a planted static class member', 'export class C { static circle = 1 }'),
  naming('circle', 'a planted private class member', 'export class C { #circle = 1 }'),
  naming('circle', 'a planted computed class member', "const K = 'circle'\nexport class C { [K] = 1 }"),
  naming('circle', 'a planted class member under a literal', "export class C { 'circle' = 1 }"),
  naming('circle', 'a planted member of a class expression', 'export const C = class { circle = 1 }'),
  naming('circle', 'a planted constructor property', 'export class C { constructor(private circle: number) {} }'),
  naming('circle', 'a planted enum member', 'export enum E { circle }'),
  naming('circle', 'a planted enum member under a literal', "export enum E { 'circle' = 1 }"),
  naming('circle', 'a planted JSX attribute', 'export const F = (X: any) => <X circle={1} />'),
  naming('circle', 'a planted bare JSX attribute', 'export const F = (X: any) => <X circle />'),
  naming('circle', 'a planted constant computed key', "const K = 'circle'\nexport const o = { [K]: 1 }"),
  naming('circle', 'a planted joined computed key', "export const o = { ['cir' + 'cle']: 1 }"),
  // A literal only once it is joined.
  naming('circle', 'a planted joined path', "export const p = './cir' + 'cle/log'"),
  naming('circle', 'a planted path joined over a constant', "const D = 'circle'\nexport const p = `${D}/log`"),
  naming('circle', 'a planted path joined over a constant and a variable', "const D = 'circle'\nexport const p = (x: string) => `${D}/${x}`"),
  naming('circle', 'a planted path joined inside something else', "export const p = (x: string) => x + ('cir' + 'cle/log')"),
]

const REFUSALS = [
  refusal('a computed read of services', 'export const f = (env: any, k: string) => env.services[k]'),
  refusal('a computed read of a holder', 'export const f = (env: any, k: string) => {\n  const s = env.services\n  return s[k]\n}'),
  refusal('a computed read of the services type', `${TYPE}export const f = (s: KernelServices, k: 'a') => s[k]`),
  refusal('a computed key in a pattern over services', 'export const f = (env: any, k: string) => {\n  const { [k]: v } = env.services\n  return v\n}'),
  refusal('a computed reflective read', 'export const f = (env: any, k: string) => Reflect.get(env.services, k)'),
  refusal('every key of the services', 'export const f = (env: any) => Object.keys(env.services)'),
  refusal('a loop over the keys of the services', 'export const f = (env: any) => { for (const k in env.services) return k }'),
  refusal('the services returned from a method', 'export const o = { get(env: any) { return env.services } }'),
  refusal('the services returned from a callback', 'export const f = (env: any, g: any) => g(() => env.services)'),
  refusal('the services assigned to a member', 'export const f = (env: any, o: any) => { o.kernel = env.services }'),
  refusal('the services in a class member', 'export const f = (env: any) => class { s = env.services }'),
  refusal('the services under a computed key', 'export const f = (env: any, k: string) => ({ [k]: env.services })'),
  refusal('the services in an object returned', 'export const f = (env: any) => ({ s: env.services })'),
  refusal('the services in an array returned', 'export const f = (env: any) => [env.services]'),
  refusal('the services in an array handed on', 'export const f = (env: any, g: any) => g([env.services])'),
  refusal('the services in a hook of somebody else', 'export const f = (env: any, useThing: any) => useThing(() => 1, [env.services])'),
  refusal('a named object read by a computed key', 'export const f = (env: any, k: string) => {\n  const o = { s: env.services }\n  return o[k]\n}'),
  refusal('a named array handed on', 'export const f = (env: any, g: any) => {\n  const all = [env.services]\n  return g(all)\n}'),
  refusal('a named object exported', 'declare const env: any\nconst o = { s: env.services }\nexport { o }'),
  refusal('a function returning services handed on', 'export const f = (env: any, h: any) => {\n  const g = () => env.services\n  return h(g)\n}'),
  refusal('a generic this cannot see into', `${TYPE}import type { Ref } from 'somewhere'\nexport const f = (r: Ref<KernelServices>) => r`),
  refusal('a map of services', `${TYPE}export const f = (m: Map<string, KernelServices>) => m`),
  refusal('a record of services', `${TYPE}export const f = (m: Record<string, KernelServices>) => m`),
  refusal('an array of arrays of services', `${TYPE}export const f = (m: KernelServices[][]) => m`),
  refusal('a member of a type under another name', `${TYPE}export interface P { kernel: KernelServices }`),
  refusal('a member of a type literal under another name', `${TYPE}export const f = (p: { kernel: KernelServices }) => p`),
  refusal('a class field under another name', `${TYPE}export class C { kernel!: KernelServices }`),
  refusal('a constructor property under another name', `${TYPE}export class C { constructor(private kernel: KernelServices) {} }`),
  refusal('a member holding an array of services', `${TYPE}export interface P { services: KernelServices[] }`),
  refusal('a member returning services under another name', `${TYPE}export interface P { get: () => KernelServices }`),
  refusal('a method returning services under another name', `${TYPE}export interface P { get(): KernelServices }`),
  refusal('an exported function returning services under another name', 'declare const env: any\nexport const g = () => env.services'),
  refusal('an exported declaration returning services under another name', 'declare const env: any\nexport function g() { return env.services }'),
  refusal('an exported function annotated to return services under another name', `${TYPE}export declare function g(): KernelServices`),
  refusal('an exported value holding services under another name', 'declare const env: any\nexport const kernel = env.services'),
  refusal('a default export of services', 'declare const env: any\nconst s = env.services\nexport default s'),
  refusal('a list export renaming a function returning services', 'declare const env: any\nconst g = () => env.services\nexport { g as h }'),
  refusal('an import renaming services', "import { services as kernel } from './x'\nexport const f = () => kernel"),
  refusal('an import renaming a function ending in services', "import { getServices as g } from './x'\nexport const f = () => g()"),
  refusal('a re-export renaming services', "export { services as kernel } from './x'"),
]

const QUIET = [
  quiet('the services handed on as themselves', `${TYPE}export const f = (s: KernelServices, g: any) => g(s)`),
  quiet('the services under their own name in an object', 'export const f = (env: any, g: any) => g({ services: env.services })'),
  quiet('the services under their own name in a named object', 'export const f = (env: any, g: any) => {\n  const ctx = { services: env.services }\n  return g(ctx)\n}'),
  quiet('the services spread under their own name', "export const f = (env: any, g: any) => {\n  const ctx = { services: { ...env.services, x: 1 } }\n  return g(ctx)\n}"),
  quiet('the services handed as a prop', 'export const F = (X: any, env: any) => <X services={env.services} />'),
  quiet('the services in a dependency list', "import { useEffect } from 'react'\nexport const f = (env: any) => useEffect(() => {}, [env.services])"),
  quiet('the services in a dependency list, by namespace', "import * as React from 'react'\nexport const f = (env: any) => React.useMemo(() => 1, [env.services])"),
  quiet('a member of the services by a type', `${TYPE}export const f = (fs: KernelServices['fs'], k: keyof KernelServices) => [fs, k]`),
  quiet('a member typed as services under their own name', `${TYPE}export interface P { services: KernelServices }\nexport class C { readonly services!: KernelServices }`),
  quiet('a function ending in services returning them, exported', 'declare const env: any\nexport const getServices = () => env.services'),
  quiet('services exported as services', 'declare const env: any\nexport const services = env.services'),
  quiet('a local of that name made from something else', 'export const f = (g: any, k: string) => {\n  const services = g()\n  return [services[k], Object.keys(services)]\n}'),
  quiet('a generic with no services in it', "import type { Ref } from 'somewhere'\nexport const f = (r: Ref<number>, m: Map<string, number>) => [r, m]"),
  quiet('a generic holding services under their own name', `${TYPE}type Box<T> = { services: T }\nexport const f = (b: Box<KernelServices>) => b`),
  quiet('a computed key on an object that is not the services', 'export const f = (k: string, o: any) => [{ [k]: 1 }, o[k]]'),
  quiet('a name built from what is not a constant', "export const f = (x: string) => 'cir' + x"),
  quiet('a join that only ends in the word', "const D = 'circle'\nexport const f = (x: string) => `${D}${x}`"),
  quiet('a file with a word for nothing here', 'export const f = (s: any) => s.passages'),
  {
    name: 'a join with a part that names it is said once',
    files: { 'src/kernel/b.ts': "export const p = (x: string) => './cir' + 'cle' + '/circle/' + x\n" },
    rows: [{ id: 'circle', file: 'src/kernel/b.ts', match: '/circle/', count: 1, reason: 'held on purpose' }, ALLOWED],
    expect: [],
  },
  {
    name: 'what could not be followed takes a row with a reason',
    files: { 'src/kernel/b.ts': 'export const f = (env: any, k: string) => env.services[k]\n' },
    rows: [{ id: '(unfollowed)', file: 'src/kernel/b.ts', match: 'a key this cannot read: env.services[k]', count: 1, reason: 'held on purpose' }, ALLOWED],
    expect: [],
  },
]

export const CASES = [
  { name: 'a legal tree is clean', files: {}, rows: [ALLOWED], expect: [] },
  { name: 'a planted import path', files: { 'src/kernel/b.ts': "import './core/public/x'\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [public]'] },
  { name: 'a planted path in a template', files: { 'src/kernel/b.ts': 'export const f = (d: string) => `${d}/public/${d}`\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [public]'] },
  { name: 'a planted file name', files: { 'src/kernel/b.ts': "export const p = 'public.jsonl'\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [public]'] },
  { name: 'a planted id-prefixed key', files: { 'src/kernel/b.ts': "export const k = 'circle:shelf'\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted services member', files: { 'src/kernel/b.ts': 'export const f = (env: any) => env.services.passages()\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted key of an object value', files: { 'src/kernel/b.tsx': 'export const o = { circle: { n: 1 } }\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.tsx [circle]'] },
  { name: 'a planted shorthand key', files: { 'src/kernel/b.ts': "const circle = 1\nexport const o = { circle }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted computed key', files: { 'src/kernel/b.ts': "export const o = { ['circle']: { n: 1 } }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted computed key in a bare template', files: { 'src/kernel/b.ts': "export const o = { [`circle`]: { n: 1 } }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted computed method', files: { 'src/kernel/b.ts': "export const o = { ['circle']() {} }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted getter', files: { 'src/kernel/b.ts': "export const o = { get circle() { return 1 } }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted setter', files: { 'src/kernel/b.ts': "export const o = { set circle(_v: number) {} }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted computed getter', files: { 'src/kernel/b.ts': "export const o = { get ['circle']() { return 1 } }\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [circle]'] },
  { name: 'a planted literal lookup of services', files: { 'src/kernel/b.ts': "export const f = (ctx: any) => ctx['services'].passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted optional literal lookup of services', files: { 'src/kernel/b.ts': "export const f = (ctx: any) => ctx?.['services'].passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted literal lookup on a literal lookup of services', files: { 'src/kernel/b.ts': "export const f = (ctx: any) => ctx['services']['passages']\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted member of parenthesised services', files: { 'src/kernel/b.ts': "export const f = (env: any) => (env.services).passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted member of asserted services', files: { 'src/kernel/b.ts': "export const f = (env: any) => env.services!.passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted member of cast services', files: { 'src/kernel/b.ts': "export const f = (env: any) => (env.services as any).passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted destructuring of services', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  const { passages } = env.services\n  return passages\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted renaming destructuring of services', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  const { passages: p } = env['services']\n  return p\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted nested destructuring of services', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const { services: { passages } } = env\n  return passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted renaming nested destructuring', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const { services: { passages: p } } = env\n  return p\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted deep nested destructuring', files: { 'src/kernel/b.ts': 'export const f = (e: any) => {\n  const { a: { services: { passages } } } = e\n  return passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted nested destructuring under a literal key', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  const { ['services']: { passages } } = env\n  return passages\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted nested destructuring with a default', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const { services: { passages } = {} as any } = env\n  return passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted destructured parameter', files: { 'src/kernel/b.ts': 'export const f = ({ services: { passages } }: any) => passages\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted destructured parameter of a method', files: { 'src/kernel/b.ts': 'export const o = { m({ services: { passages } }: any) { return passages } }\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted destructured parameter with services as its default', files: { 'src/kernel/b.ts': 'export const f = (env: any) => ({ passages } = env.services) => passages\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted destructuring of a parameter called services', files: { 'src/kernel/b.ts': 'export const f = (services: any) => {\n  const { passages } = services\n  return passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted alias of services', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const s = env.services\n  return s.passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted alias of an alias, declared later', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const g = () => t.passages\n  const t = s\n  return g\n  var s = env.services\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted renamed services', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const { services: s } = env\n  return s.passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted renamed services parameter', files: { 'src/kernel/b.ts': "export const f = ({ services: s }: any) => s['passages']\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted defaulted parameter', files: { 'src/kernel/b.ts': 'export const f = (env: any) => (s = env.services) => s.passages\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted default inside a pattern', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const { s = env.services } = env\n  return s.passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted assigned alias', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  let s: any\n  s = env.services\n  return s.passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted rest of services, then read', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const { other, ...rest } = env.services\n  return [other, rest.passages]\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted rest in a nested pattern, then read', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  const { services: { ...rest } } = env\n  return rest.passages\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted destructuring assignment', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  let p: any\n  ;({ passages: p } = env.services)\n  return p\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted nested destructuring assignment', files: { 'src/kernel/b.ts': 'export const f = (env: any) => {\n  let p: any\n  ;({ services: { passages: p } } = env)\n  return p\n}\n' }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted key in a conditional', files: { 'src/kernel/b.ts': "export const f = (env: any, x: boolean) => env.services[x ? 'passages' : 'other']\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted parameter of the services type', files: { 'src/kernel/b.ts': "import type { KernelServices } from './core/services'\nexport const f = (s: KernelServices) => (s as any).passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted pattern of the services type', files: { 'src/kernel/b.ts': "import type { KernelServices } from './core/services'\nexport const f = ({ passages }: KernelServices) => passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted local of a type picked from services', files: { 'src/kernel/b.ts': "import type { KernelServices } from './core/services'\nexport const f = (s: Pick<KernelServices, 'passages'>) => s.passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted local of a partial of services', files: { 'src/kernel/b.ts': "import type { KernelServices } from './core/services'\nexport const f = (s: Partial<KernelServices>) => s.passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted local of a readonly pick of services', files: { 'src/kernel/b.ts': "import type { KernelServices } from './core/services'\nexport const f = (s: Readonly<Pick<KernelServices, 'passages'>>) => s.passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted renamed services with a default', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  const { services: s = {} as any } = env\n  return s.passages\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted renamed services with a default, by assignment', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  let s: any\n  ;({ services: s = {} } = env)\n  return s.passages\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted nested assignment pattern with a default', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  let p: any\n  ;({ services: { passages: p } = {} as any } = env)\n  return p\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted shorthand default of services, by assignment', files: { 'src/kernel/b.ts': "export const f = (env: any, o: any) => {\n  let s: any\n  ;({ s = env.services } = o)\n  return s.passages\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted renamed default of services, by assignment', files: { 'src/kernel/b.ts': "export const f = (env: any, o: any) => {\n  let s: any\n  ;({ x: s = env.services } = o)\n  return s.passages\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a generic that holds the services under a key is not the services, and is refused', files: { 'src/kernel/b.ts': "import type { KernelServices } from './core/services'\ntype Box<T> = { value: T; passages: number }\nexport const f = (box: Box<KernelServices>) => box.passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [(unfollowed)]'] },
  { name: 'an array of a pick of services is not the services', files: { 'src/kernel/b.ts': "import type { KernelServices } from './core/services'\nexport const f = (all: Array<Pick<KernelServices, 'passages'>>) => (all as any).passages\n" }, rows: [ALLOWED], expect: [] },
  { name: 'a defaulted key other than services holds nothing', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  let s: any\n  ;({ other: s = {} } = env)\n  return s.passages\n}\n" }, rows: [ALLOWED], expect: [] },
  { name: 'a shorthand default of something else holds nothing', files: { 'src/kernel/b.ts': "export const f = (o: any) => {\n  let s: any\n  ;({ s = {} } = o)\n  return s.passages\n}\n" }, rows: [ALLOWED], expect: [] },
  { name: 'a planted local of a union with services', files: { 'src/kernel/b.ts': "import type { KernelServices } from './core/services'\nexport const f = (s: KernelServices | null) => s!.passages\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  { name: 'a planted array pattern over services', files: { 'src/kernel/b.ts': "export const f = (env: any) => {\n  let s: any\n  ;[s] = [env.services]\n  return s.passages\n}\n" }, rows: [ALLOWED], expect: ['NEW src/kernel/b.ts [passages]'] },
  ...PLANTED,
  ...REFUSALS,
  ...QUIET,
  { name: 'a second naming on an allowed row', files: { 'src/kernel/a.ts': `${CLEAN}${CLEAN}` }, rows: [ALLOWED], expect: ['COUNT src/kernel/a.ts [circle]'] },
  { name: 'a row whose naming has gone', files: { 'src/kernel/a.ts': 'export const a = 1\n' }, rows: [ALLOWED], expect: ['STALE src/kernel/a.ts [circle]'] },
  {
    name: 'a row for an id cut from the manifest is inert',
    files: {},
    rows: [ALLOWED, { ...ALLOWED, id: 'gone', match: './gone/x' }],
    expect: [],
    inert: 1,
  },
  {
    name: 'the bare word, a comment, a test and a type member are not namings',
    files: {
      'src/kernel/b.tsx':
        "// './core/public/x' and services.circle\n" +
        "/* circle: { } */\n" +
        "export type T = { readonly circle: string; public: number }\n" +
        "export const f = (passages: string, circle = 'circle') => <p>don't say circle: {passages}{circle}</p>\n",
      'src/kernel/c.ts':
        "export const f = (circle: string, other: any) => {\n" +
        "  const { passages } = other\n" +
        "  const { passages: renamed } = other['elsewhere']\n" +
        "  return [{ [circle]: 1, [other.circle]: 2 }, other['elsewhere'].passages, passages, renamed]\n" +
        "}\n" +
        "export const g = (env: any, other: any) => {\n" +
        "  const { ...circle } = env.services\n" +
        "  const { services: { ...passages } } = env\n" +
        "  const { elsewhere: { circle: one } } = env\n" +
        "  const { passages: { circle: two } } = other\n" +
        "  const shadow = other\n" +
        "  let three: any\n" +
        "  ;({ circle: three } = other)\n" +
        "  void circle\n" +
        "  void passages\n" +
        "  return [one, two, three, shadow.circle]\n" +
        "}\n" +
        "export const h = (x: any) => { const s = x.services; { const s = x; return s.circle } }\n" +
        "export type U = { get circle(): string }\n",
      'src/kernel/b.test.ts': "import './core/public/x'\n",
      'src/kernel/b.testkit.ts': "import './core/public/y'\n",
    },
    rows: [ALLOWED],
    expect: [],
  },
]

/** `{ name, problems }`: empty when the case behaved. */
export function runCase(testCase) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'residue-selftest-')))
  try {
    for (const [file, text] of Object.entries({ 'src/kernel/a.ts': CLEAN, ...testCase.files })) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      writeFileSync(path.join(root, file), text)
    }
    const { findings, inert } = compare(scan(root, IDS), parseAllowList(JSON.stringify({ rows: testCase.rows })), IDS)
    const problems = []
    if (findings.length !== testCase.expect.length) problems.push(`expected ${testCase.expect.length} finding(s), got: ${findings.join(' | ') || 'none'}`)
    testCase.expect.forEach((prefix, index) => {
      if (!findings[index]?.startsWith(prefix)) problems.push(`expected "${prefix}…", got "${findings[index]}"`)
    })
    if (inert !== (testCase.inert ?? 0)) problems.push(`expected ${testCase.inert ?? 0} inert row(s), got ${inert}`)
    return { name: testCase.name, problems }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (isProcessEntry(import.meta)) {
  const results = CASES.map(runCase)
  for (const { name, problems } of results) process.stdout.write(`${problems.length === 0 ? 'ok  ' : 'FAIL'} ${name}\n${problems.map((one) => `     ${one}\n`).join('')}`)
  process.exitCode = results.every(({ problems }) => problems.length === 0) ? 0 : 1
}
