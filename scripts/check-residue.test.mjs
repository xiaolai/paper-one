import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { ALLOW_LIST, compare, main, parseAllowList, parseArgs, scan, UNFOLLOWED } from './check-residue.mjs'
import { CASES, runCase } from './check-residue.selftest.mjs'

const roots = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
/** A root holding these files and nothing else. */
const tree = (files) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'residue-')))
  roots.push(root)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}
const IDS = ['circle', 'public', 'passages']
const B = 'src/kernel/b.tsx'
const TYPE = "import type { KernelServices } from './core/services'\n"
/** Every naming a scan finds, as `[file, id, match, count]`. */
const scanned = (files, ids = IDS) => [...scan(tree(files), ids)].map(([key, count]) => [...JSON.parse(key), count])
const named = (id, match) => [B, id, match, 1]
const refused = (match) => [B, UNFOLLOWED, match, 1]
const at = (row) => row
const thrown = (fn) => {
  try {
    fn()
  } catch (error) {
    return error.message
  }
  return 'nothing thrown'
}

/* FIRST, BECAUSE THEY ARE QUICK: a scan that strays out of the kernel would walk the
   whole repository in the run against this tree, further down. */
describe('where the scan looks', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  /* With the library loaded, `Map` would be read through its declaration, whose members
     are methods, and would hold nothing. Without it, a generic this cannot see into holds
     what it is given. */
  it('loads no library, so a generic it declares is one this cannot see into', () => {
    expect(scanned({ [B]: `${TYPE}export const f = (m: Map<string, KernelServices>) => m\n` })).toEqual([refused('a type holding the services where this cannot see them: Map<string, KernelServices>')])
  })

  it('reads the kernel and nothing beside it', () => {
    expect(scanned({ [B]: "export const x = './passages/x'\n", 'src/other.ts': "export const x = './circle/x'\n" })).toEqual([named('passages', './passages/x')])
  })

  it('reads TypeScript sources, and not their tests, test kits or declarations', () => {
    expect(
      scanned({
        'src/kernel/a.ts': "export const x = './circle/a'\n",
        'src/kernel/b.tsx': "export const x = './circle/b'\n",
        'src/kernel/c.ts.md': "export const x = './circle/c'\n",
        'src/kernel/d.test.ts': "export const x = './circle/d'\n",
        'src/kernel/e.testkit.tsx': "export const x = './circle/e'\n",
        'src/kernel/f.d.ts': "export declare const x = './circle/f'\n",
        'src/kernel/g.test.ts-kit.ts': "export const x = './circle/g'\n",
        'src/kernel/h.d.ts.ts': "export const x = './circle/h'\n",
        'src/kernel/i.js': "export const x = './circle/i'\n",
      }).map(([file]) => file),
    ).toEqual(['src/kernel/a.ts', 'src/kernel/b.tsx', 'src/kernel/g.test.ts-kit.ts', 'src/kernel/h.d.ts.ts'])
  })

  it('refuses a kernel with no source in it, rather than call it clean', () => {
    const root = tree({ 'src/kernel/notes.md': '' })
    expect(thrown(() => scan(root, IDS))).toBe(`src/kernel: no source files under ${root}`)
  })

  it('takes the files in path order, whatever order the disk lists them in', async () => {
    vi.doMock('node:fs', async (importOriginal) => {
      const fs = await importOriginal()
      return { ...fs, readdirSync: (dir) => fs.readdirSync(dir).reverse() }
    })
    vi.resetModules()
    const reversed = await import('./check-residue.mjs')
    const root = tree({ 'src/kernel/a.ts': "export const x = './circle/a'\n", 'src/kernel/b/c.ts': "export const x = './circle/c'\n", 'src/kernel/d.ts': "export const x = './circle/d'\n" })
    expect([...reversed.scan(root, IDS).keys()].map((key) => JSON.parse(key)[0])).toEqual(['src/kernel/a.ts', 'src/kernel/b/c.ts', 'src/kernel/d.ts'])
  })

  it('counts a naming each time it occurs', () => {
    expect(scanned({ [B]: "export const x = ['./circle/x', './circle/x']\n" })).toEqual([[B, 'circle', './circle/x', 2]])
  })
})

/* THE WHOLE ANSWER for each form: what is named, and what is refused, word for word. */
describe('what the scan finds, form by form', () => {
  it.each([
    ['method member', `${TYPE}type Box<T> = { m(): T }\nexport const f = (b: Box<KernelServices>) => b`, []],
    ['services member', `${TYPE}type Box<T> = { services: T }\nexport const f = (b: Box<KernelServices>) => b`, []],
    ['rest tuple', `${TYPE}export const f = (all: [...KernelServices[]]) => all`, [refused("a type holding the services where this cannot see them: [...KernelServices[]]")]],
    ['optional tuple', `${TYPE}export const f = (all: [KernelServices?]) => all[0]!.passages`, [named("passages", "services.passages")]],
    ['Pick', `${TYPE}export const f = (s: Pick<KernelServices, 'passages'>) => s.passages`, [named("passages", "services.passages")]],
    ['Partial', `${TYPE}export const f = (s: Partial<KernelServices>) => s.passages`, [named("passages", "services.passages")]],
    ['Readonly', `${TYPE}export const f = (s: Readonly<KernelServices>) => s.passages`, [named("passages", "services.passages")]],
    ['Promise', `${TYPE}export const f = async (p: Promise<KernelServices>) => (await p).passages`, [named("passages", "services.passages")]],
    ['Array', `${TYPE}export const f = (all: Array<KernelServices>) => all[0].passages`, [named("passages", "services.passages")]],
    ['keyof', `${TYPE}export const f = (k: keyof KernelServices) => k`, []],
    ['readonly tuple', `${TYPE}export const f = (all: readonly [KernelServices]) => all[0].passages`, [named("passages", "services.passages")]],
    ['fn returning', `${TYPE}export const f = (g: () => KernelServices) => g().passages`, [named("passages", "services.passages")]],
    ['fn returning array', `${TYPE}export const f = (g: () => KernelServices[]) => g()`, []],
    ['typeof other', 'export const f = (env: any, s: typeof env.other) => s.passages', []],
    ['class extends generic', `${TYPE}class Base<T> { value!: T }\nclass C extends Base<KernelServices> {}\nexport const f = (c: C) => c`, [refused("a type holding the services where this cannot see them: C")]],
    ['typeless holder', `${TYPE}export const f = (o: { s: KernelServices }) => o`, [refused("a member holding the services under another name: s: KernelServices")]],
    ['private hash', 'export class C { #passages = 1 }', [named("passages", "passages:")]],
    ['enum', 'export enum E { circle = 1 }', [named("circle", "circle:")]],
    ['template', 'export const f = (x: string) => `${x}/circle/y`', [named("circle", "/circle/y")]],
    ['template join', 'export const f = (x: string) => `cir${"cle"}/${x}`', [named("circle", "circle/${…}")]],
    ['elements param', `${TYPE}export const f = ([s]: KernelServices[]) => s.passages`, [named("passages", "services.passages")]],
    ['returns var', `${TYPE}export const f = (g: () => KernelServices) => { const h = g; return h().passages }`, [refused("a function that returns it, handed on: g")]],
    ['alias get', 'export const f = (env: any) => { const get = env.getServices; return get().passages }', [named("passages", "services.passages")]],
    ['alias services', 'export const f = (env: any) => { const get = env.services; return get().passages }', []],
    ['alias named', 'export const f = (env: any) => { const readServices = env.getServices; return readServices().passages }', [named("passages", "services.passages")]],
    ['alias call', 'export const f = (env: any) => { const get = env.getServices(); return get.passages }', [named("passages", "services.passages")]],
    ['getter', `${TYPE}export class C { get s(): KernelServices { return null as any } }`, [refused("a method returning the services under another name: s")]],
    ['param property', `${TYPE}export class C { constructor(private s: KernelServices) {} }`, [refused("a member holding the services under another name: private s: KernelServices")]],
    ['property decl', `${TYPE}export class C { s!: KernelServices }`, [refused("a member holding the services under another name: s!: KernelServices")]],
    ['member ends services', `${TYPE}export interface I { getServices: () => KernelServices }`, []],
    ['wrapped cast root', `${TYPE}export const f = (x: unknown) => ((x as KernelServices)!).passages`, [named("passages", "services.passages")]],
    ['handed on typed', "import { use } from './c'\nexport const f = (services: any) => use(services)", [at(["src/kernel/c.ts","(unfollowed)","a function returning the services, exported under another name: use",1])], { 'src/kernel/c.ts': `${TYPE}export function use(s: KernelServices) { return s }\n` }],
    ['handed on named', "import { use } from './c'\nexport const f = (services: any) => use(1, services)", [], { 'src/kernel/c.ts': 'export function use(a: number, services: any) { return a }\n' }],
    ['handed on rest', "import { use } from './c'\nexport const f = (services: any) => use(services)", [refused("handed to a call: services")], { 'src/kernel/c.ts': 'export function use(...services: any[]) { return 1 }\n' }],
    ['handed on ns', "import * as c from './c'\nexport const f = (services: any) => c.use(services)", [], { 'src/kernel/c.ts': 'export function use(services: any) { return 1 }\n' }],
    ['handed on renamed', "import { use as u } from './c'\nexport const f = (services: any) => u(services)", [], { 'src/kernel/c.ts': 'export function use(services: any) { return 1 }\n' }],
    ['handed on local', 'const use = (services: any) => 1\nexport const f = (services: any) => use(services)', []],
    ['export fn ends services', 'export function readServices(services: any) { return services }', []],
    ['rename type', "import { KernelServices as K } from './x'\nexport { K as L } from './y'", []],
    ['rename same', "export { readServices as readServices } from './y'", []],
    ['rename to services', "import { readServices as getServices } from './y'", []],
    ['import default', "import services from './y'\nexport const f = services.passages", [named("passages", "services.passages")]],
    ['ts.md', '', [], { 'src/kernel/c.ts.md': "export const x = './passages/x'\n" }],
    ['test-kit', '', [at(["src/kernel/c.test.ts-kit.ts","passages","./passages/x",1])], { 'src/kernel/c.test.ts-kit.ts': "export const x = './passages/x'\n" }],
    ['d.ts', '', [], { 'src/kernel/c.d.ts': "export declare const x = './passages/x'\n" }],
    ['keep Omit<KernelServices, \"x\">', `${TYPE}export const f = (s: Omit<KernelServices, "x">) => s.passages`, [named("passages", "services.passages")]],
    ['keep Required<KernelServices>', `${TYPE}export const f = (s: Required<KernelServices>) => s.passages`, [named("passages", "services.passages")]],
    ['keep NonNullable<KernelServices>', `${TYPE}export const f = (s: NonNullable<KernelServices>) => s.passages`, [named("passages", "services.passages")]],
    ['keep PromiseLike<KernelServices>', `${TYPE}export const f = (s: PromiseLike<KernelServices>) => s.passages`, [named("passages", "services.passages")]],
    ['keep Awaited<KernelServices>', `${TYPE}export const f = (s: Awaited<KernelServices>) => s.passages`, [named("passages", "services.passages")]],
    ['elem ReadonlyArray', `${TYPE}export const f = (all: ReadonlyArray<KernelServices>) => { for (const s of all) return s.passages }`, [named("passages", "services.passages")]],
    ['elem Set', `${TYPE}export const f = (all: Set<KernelServices>) => { for (const s of all) return s.passages }`, [named("passages", "services.passages")]],
    ['elem ReadonlySet', `${TYPE}export const f = (all: ReadonlySet<KernelServices>) => { for (const s of all) return s.passages }`, [named("passages", "services.passages")]],
    ['servicesCount', 'export const f = (o: any) => o.servicesCount().passages', []],
    ['arr arr', `${TYPE}export const f = (all: KernelServices[][]) => all`, [refused("a type holding the services where this cannot see them: KernelServices[][]")]],
    ['arr arr union', `${TYPE}export const f = (all: KernelServices[][] | null) => all`, [refused("a type holding the services where this cannot see them: KernelServices[][]")]],
    ['rename cycle', "import type { K } from './types'\nexport const f = (s: K) => s.passages", [], { 'src/kernel/types.ts': "export type { J as K } from './x'\nexport type { K as J } from './y'\n" }],
    ['box nongeneric', `${TYPE}interface Box { value: KernelServices }\nexport const f = (b: Box) => b`, [refused("a member holding the services under another name: value: KernelServices")]],
    ['typeless member', `${TYPE}type Box<T> = { x; value: T }\nexport const f = (b: Box<KernelServices>) => b`, [refused("a type holding the services where this cannot see them: Box<KernelServices>")]],
    ['only typeless member', `${TYPE}type Box<T> = { x }\nexport const f = (b: Box<KernelServices>) => b`, []],
    ['index sig', `${TYPE}type Box<T> = { [k: string]: T }\nexport const f = (b: Box<KernelServices>) => b`, [refused("a type holding the services where this cannot see them: Box<KernelServices>")]],
    ['alias cycle', `${TYPE}type A = B\ntype B = A\nexport const f = (s: A) => s.passages`, []],
    ['outer param', `${TYPE}type Local<U> = U | null\ntype Box<T> = Local<T>\nexport const f = (s: Box<KernelServices>) => s!.passages`, [named("passages", "services.passages")]],
    ['default outer', `${TYPE}type Local<T = U> = T | null\ntype Box<U> = Local\nexport const f = (s: Box<KernelServices>) => s!.passages`, []],
    ['ReturnType F', `${TYPE}type F = () => KernelServices\nexport const f = (s: ReturnType<F>) => s.passages`, []],
    ['ReturnType bare', `${TYPE}export const f = (s: ReturnType) => s`, []],
    ['Partial bare', `${TYPE}export const f = (s: Partial) => s`, []],
    ['Set bare', `${TYPE}export const f = (s: Set) => s`, []],
    ['local type', `${TYPE}export function f() { type S = KernelServices; const g = (s: S) => s.passages; return g }`, [named("passages", "services.passages")]],
    ['conditional', `${TYPE}export const f = (s: 1 extends 1 ? KernelServices : null) => s!.passages`, [named("passages", "services.passages")]],
    ['named tuple', `${TYPE}export const f = (all: [s: KernelServices]) => all[0].passages`, [named("passages", "services.passages")]],
    ['import type bare', "export const f = (s: import('./core/services')) => s", []],
    ['handed S', "import { S } from './x'\nexport const f = (services: any) => S(services)", [refused("handed to a call: services")]],
    ['readServices twice', "import { readServices } from './c'\nexport const f = () => readServices().passages", [named("passages", "services.passages")], { 'src/kernel/c.ts': 'export function readServices(): string[] { return [] }\n', 'src/kernel/d.ts': 'export function readServices() { return 1 }\n' }],
    ['readServices typed', "import { readServices } from './c'\nexport const f = () => readServices().passages", [named("passages", "services.passages")], { 'src/kernel/c.ts': `${TYPE}export function readServices(): KernelServices { return null as any }\n` }],
    ['untyped param', "import { use } from './c'\nexport const f = (services: any) => use(services)", [refused("handed to a call: services")], { 'src/kernel/c.ts': 'export function use(x) { return x }\n' }],
    ['use is a value', "import { use } from './c'\nexport const f = (services: any) => use(services)", [refused("handed to a call: services")], { 'src/kernel/c.ts': 'export const use = makeUse()\n' }],
    ['default alias no word', "import type { Local } from './types'\nexport const f = (s: Local) => s!.passages", [named("passages", "services.passages")], { 'src/kernel/types.ts': `${TYPE}export type Local<T = KernelServices> = T | null\n` }],
    ['long quote', "export const f = (services: any, k: string) => services[k +\n  'a-suffix-long-enough-to-run-well-past-the-sixty-character-cut']", [refused("a key this cannot read: services[k + 'a-suffix-long-enough-to-run-well-past-the-sixt")]],
    ['or join', "export const f = (x: string) => x || 'cle/x' || ('cir' || 'cle/x')", []],
    ['gap join', "export const f = (x: string) => 'cir' + x + 'cle/x'", []],
    ['circle + /x', "export const f = () => 'circle' + '/x'", [named("circle", "circle/x")]],
    ['null id join', "export const f = () => 'nu' + 'll/x'", [named("null", "null/x")], {}, ["null"]],
    ['null id x+y', 'export const f = (x: string, y: string) => x + y', [], {}, ["null"]],
    ['null id plain', 'export const f = 1', [], {}, ["null"]],
    ['hash key', "export const o = { 'cir#cle': 1 }\nexport class C { #circle = 1 }", [named("circle", "circle:")]],
    ['jsx', 'export const F = (X: any) => <X circle={1} />', [named("circle", "circle=")]],
    ['undeclared g', 'export const f = (services: any) => g(services)', [refused("handed to a call: services")]],
    ['undefined call', 'export const f = (services: any) => undefined(services)', [refused("handed to a call: services")]],
    ['ns call', "import * as ns from './x'\nexport const f = (services: any) => ns()(services)", [refused("handed to a call: services")]],
    ['x.y call', 'export const f = (services: any) => x.y(services)', [refused("handed to a call: services")]],
    ['anon fn decl', `${TYPE}export default function (): KernelServices { return null as any }\nexport const f = () => g().passages`, []],
    ['arrow in call', `${TYPE}use((): KernelServices => null as any)\nexport const f = () => g().passages`, []],
    ['arrow const', `${TYPE}const get = (): KernelServices => null as any\nexport const f = () => get().passages`, [named("passages", "services.passages")]],
    ['paren arrow const', `${TYPE}const get = ((): KernelServices => null as any)\nexport const f = () => get().passages`, [named("passages", "services.passages")]],
    ['arrow in object', `${TYPE}const o = { get: (): KernelServices => null as any }\nexport const f = () => o.get().passages`, []],
    ['g = services', 'export const f = (services: any) => { const g = services; return g().passages }', []],
    ['members', `${TYPE}export interface I { a: KernelServices; b: KernelServices[]; c: () => KernelServices; readServices: () => KernelServices; [k]: () => KernelServices }`, [refused("a member holding the services under another name: a: KernelServices;"), refused("a member holding the services in an array: b: KernelServices[];"), refused("a member returning the services under another name: c: () => KernelServices;"), refused("a member returning the services under another name: [k]: () => KernelServices")]],
    ['methods', `${TYPE}export interface I { m(): KernelServices; getServices(): KernelServices; [k](): KernelServices }`, [refused("a method returning the services under another name: m"), refused("a method returning the services under another name: [k]")]],
    ['every key', 'export const f = (services: any) => Object.keys(services)', [refused("every key of the services: Object.keys(services)")]],
    ['leaving fn', 'export function readThem(services: any) { return services }', [refused("a function returning the services, exported under another name: readThem")]],
    ['leaving held', 'export const f = (services: any) => 1\nexport const s = (globalThis as any).services', [refused("the services, exported under another name: s")]],
    ['renames', "import { services as kernelServices, services as services, readServices as read, KernelServices as K } from './x'\nexport { services as s2 } from './y'", [refused("the services under another name: services as kernelServices"), refused("the services under another name: readServices as read"), refused("the services under another name: services as s2")]],
    ['side import', "import './x'\nexport const f = (services: any) => 1", []],
    ['export star', "export * from './x'\nexport * as ns from './y'\nexport const f = (services: any) => 1", []],
    ['export default held', 'const s = (globalThis as any).services\nexport default s', [refused("the services, exported under another name: export default s")]],
    ['export list held', 'const s = (globalThis as any).services\nexport { s }', [refused("the services, exported under another name: s")]],
    ['export list held renamed', 'const s = (globalThis as any).services\nexport { s as services }', []],
    ['param root exported fn', 'export const f = (services: any) => services', [refused("a function returning the services, exported under another name: f")]],
    ['ns merge', "import * as ns from './x'\ndeclare namespace ns { }\nexport const f = (services: any) => ns.use(services)", [], { 'src/kernel/c.ts': 'export function use(services: any) { return 1 }\n' }],
    ['ns plain', "import * as ns from './x'\nexport const f = (services: any) => ns.use(services)", [], { 'src/kernel/c.ts': 'export function use(services: any) { return 1 }\n' }],
    ['undefined.y', 'export const f = (services: any) => undefined.y(services)', [refused("handed to a call: services")]],
    ['spread call', "import { use } from './c'\nexport const f = (services: any) => use(...[services])", [refused("held by an array: services")], { 'src/kernel/c.ts': 'export function use(services: any) { return 1 }\n' }],
    ['gap then naming', "export const f = (y: string) => y + 'cir' + 'cle/x'", [named("circle", "${…}circle/x")]],
    ['naming then gap', "export const f = (y: string) => 'cir' + 'cle/x' + y + 'z'", [named("circle", "circle/x${…}z")]],
    ['middle naming', "export const f = (y: string, z: string) => 'a' + y + 'cir' + 'cle/x' + z + 'b'", [named("circle", "a${…}circle/x${…}b")]],
    ['prefix naming', "export const f = () => '/cir' + 'cle' + 'x'", []],
    ['services as services', "import { services as services } from './x'\nexport const f = 1", []],
  ])('%s', (_name, source, expected, more = {}, ids = IDS) => {
    expect(scanned({ [B]: `${source}\n`, ...more }, ids)).toEqual(expected)
  })
})

/* EACH OF THESE THE SCAN ONCE PASSED IN SILENCE. */
describe('forms the scan once missed', () => {
  /* An exported pattern exports every name it binds, past a hole. */
  it('refuses the services exported through a pattern', () => {
    expect(scanned({ [B]: 'const services: any = 1\nexport const [s] = [services]\nexport const { t } = { t: services }\nexport const [, u] = [1, services]\n' })).toEqual([
      refused('the services, exported under another name: s'),
      refused('the services, exported under another name: t'),
      refused('the services, exported under another name: u'),
    ])
  })

  /* The services' own name is no help to an importer that receives them under another. */
  it('refuses the services exported by their own name under another', () => {
    expect(scanned({ [B]: 'const services: any = 1\nexport default services\n' })).toEqual([refused('the services, exported under another name: export default services')])
    expect(scanned({ [B]: 'const services: any = 1\nexport { services as s }\n' })).toEqual([refused('the services, exported under another name: services as s')])
    expect(scanned({ [B]: 'const services: any = 1\nexport { services }\n' })).toEqual([])
  })

  /* A class has the members of what it implements, as an interface has those of what it extends. */
  it('reads a class through the services type it implements', () => {
    expect(scanned({ [B]: `${TYPE}class S implements KernelServices {}\nexport const f = (s: S) => s.passages\n` })).toEqual([named('passages', 'services.passages')])
  })

  /* A base this cannot name is still handed the services. */
  it('refuses a class extending a call given the services type', () => {
    expect(scanned({ [B]: `${TYPE}class C extends mixin()<KernelServices> {}\nexport const f = (c: C) => c\n` })).toEqual([refused('a type holding the services where this cannot see them: C')])
  })

  /* `N.K` is the alias `K` that `N` declares, followed to what it stands for. */
  it('reads the services type through an alias reached by a qualified name', () => {
    expect(
      scanned({ [B]: "import type * as Core from './core/services'\nnamespace N { export import K = Core.KernelServices }\nexport const f = (s: N.K) => s.passages\n" }),
    ).toEqual([named('passages', 'services.passages')])
  })

  /* A function declared to return the services, standing as a default, binds to the
     name it defaults. */
  it('reads a function declared to return the services through the default it stands in', () => {
    const KS = '(): KernelServices => null as any'
    expect(scanned({ [B]: `${TYPE}export const f = (read = ${KS}) => read().passages\n` })).toEqual([named('passages', 'services.passages')])
    expect(scanned({ [B]: `${TYPE}const { r = ${KS} } = {} as any\nexport const f = () => r().passages\n` })).toEqual([named('passages', 'services.passages')])
    expect(scanned({ [B]: `${TYPE}const [r = ${KS}] = [] as any[]\nexport const f = () => r().passages\n` })).toEqual([named('passages', 'services.passages')])
    expect(scanned({ [B]: `${TYPE}export const f = (read = ${KS}) => read\n` })).toEqual([refused('a function that returns it, handed on: read')])
  })
})

describe('check-residue on a planted tree', () => {
  /* A LOOP OVER CASES IS NOT A TEST NAMED FOR EACH, so each gets its own name,
     which is what the test ledger holds. */
  for (const testCase of CASES) {
    it(testCase.name, () => {
      expect(runCase(testCase).problems).toEqual([])
    })
  }
})

describe('the allow-list', () => {
  const row = { id: 'circle', file: 'src/kernel/a.ts', match: './circle/log', count: 1, reason: 'held on purpose' }
  const refusal = (body) => thrown(() => parseAllowList(JSON.stringify(body)))
  const where = (bad) => `${ALLOW_LIST}: ${JSON.stringify(bad)}`

  it('returns its rows', () => {
    expect(parseAllowList(JSON.stringify({ rows: [row, { ...row, id: 'public', count: 2 }] }))).toEqual([row, { ...row, id: 'public', count: 2 }])
  })

  it('refuses a body with no rows array', () => {
    expect(refusal({})).toBe(`${ALLOW_LIST}: no rows array`)
    expect(refusal(null)).toBe(`${ALLOW_LIST}: no rows array`)
    expect(refusal({ rows: {} })).toBe(`${ALLOW_LIST}: no rows array`)
  })

  it.each(['id', 'file', 'match', 'reason'])('refuses a row whose %s is missing, blank or not a string', (field) => {
    for (const value of [undefined, ' ', 7]) {
      const bad = { ...row, [field]: value }
      expect(refusal({ rows: [bad] })).toBe(`${where(bad)}: needs a non-empty ${field}`)
    }
  })

  it('refuses a row that is not an object', () => {
    expect(refusal({ rows: [null] })).toBe('scripts/residue-allowlist.json: null: needs a non-empty id')
  })

  it('refuses a count that is not a positive integer', () => {
    for (const count of [0, -1, 1.5, '1', undefined]) {
      const bad = { ...row, count }
      expect(refusal({ rows: [bad] })).toBe(`${where(bad)}: count must be a positive integer`)
    }
  })

  it('refuses a row given twice', () => {
    expect(refusal({ rows: [row, { ...row, reason: 'again', count: 2 }] })).toBe(`${where({ ...row, reason: 'again', count: 2 })}: duplicate row`)
  })
})

describe('comparing a scan with the rows', () => {
  const key = (file, id, match) => JSON.stringify([file, id, match])
  const row = (id, file, match, count) => ({ id, file, match, count, reason: 'kept' })

  it('says what is new, stale or miscounted, sorted, and sets aside a row for an id not in the manifest', () => {
    const counts = new Map([
      [key('src/kernel/a.ts', 'circle', './circle/x'), 2],
      [key('src/kernel/b.ts', UNFOLLOWED, 'handed to a call: services'), 3],
      [key('src/kernel/c.ts', 'passages', 'services.passages'), 1],
      [key('src/kernel/d.ts', UNFOLLOWED, 'every key of the services: Object.keys(services)'), 4],
    ])
    const rows = [
      row('circle', 'src/kernel/a.ts', './circle/x', 2),
      row('passages', 'src/kernel/a.ts', 'services.passages', 1),
      row('retired', 'src/kernel/a.ts', './retired/x', 1),
      row(UNFOLLOWED, 'src/kernel/b.ts', 'handed to a call: services', 1),
    ]
    expect(compare(counts, rows, IDS)).toEqual({
      findings: [
        'COUNT src/kernel/b.ts [(unfollowed)] "handed to a call: services": 3 in the source, 1 on the row',
        'NEW src/kernel/c.ts [passages] "services.passages" x1: the kernel names a capability; remove it, or add a row with its reason',
        'NEW src/kernel/d.ts [(unfollowed)] "every key of the services: Object.keys(services)" x4: the kernel takes its services where this cannot follow; name the member, or add a row with its reason',
        'STALE src/kernel/a.ts [passages] "services.passages": the kernel no longer names this; delete the row',
      ],
      inert: 1,
      occurrences: 10,
    })
  })

  it('finds nothing when every naming has its row', () => {
    expect(compare(new Map([[key('src/kernel/a.ts', 'circle', './circle/x'), 1]]), [row('circle', 'src/kernel/a.ts', './circle/x', 1)], IDS)).toEqual({ findings: [], inert: 0, occurrences: 1 })
  })
})

describe('the arguments', () => {
  const REPO = fileURLToPath(new URL('..', import.meta.url))

  it('reads a root against the working directory, and defaults to this repository', () => {
    expect(parseArgs(['--root', 'a'], '/base')).toEqual({ root: '/base/a' })
    expect(parseArgs(['--root', 'a--'], '/base')).toEqual({ root: '/base/a--' })
    expect(parseArgs(['--root', '/elsewhere'], '/base')).toEqual({ root: '/elsewhere' })
    expect(parseArgs([], '/base')).toEqual({ root: REPO })
  })

  it('refuses what it does not understand', () => {
    expect(parseArgs(['--write'])).toEqual({ error: 'unknown argument "--write"' })
    expect(parseArgs(['--root', 'a', 'b'])).toEqual({ error: 'unknown argument "b"' })
    expect(parseArgs(['--root'])).toEqual({ error: '--root needs a directory' })
    expect(parseArgs(['--root', '--x'])).toEqual({ error: '--root needs a directory' })
    expect(parseArgs(['--root', 'a', '--root', 'b'])).toEqual({ error: '--root given twice' })
  })
})

describe('what the command prints, and how it exits', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.restoreAllMocks()
    vi.resetModules()
  })
  const capture = () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const text = (spy) => spy.mock.calls.map(([written]) => written).join('')
    return () => ({ stdout: text(out), stderr: text(err) })
  }
  const run = (argv, command = main) => {
    const printed = capture()
    const code = command(argv)
    return { code, ...printed() }
  }
  const project = (rows, files) =>
    tree({ 'capabilities.manifest.json': JSON.stringify({ capabilities: IDS.map((id) => ({ id })) }), [ALLOW_LIST]: JSON.stringify({ rows }), ...files })
  const kept = (id, file, match, count) => ({ id, file, match, count, reason: 'kept' })

  it('prints a summary and exits 0 when every naming has its row', () => {
    const root = project([kept('circle', 'src/kernel/a.ts', './circle/x', 1)], { 'src/kernel/a.ts': "export const x = './circle/x'\n" })
    expect(run(['--root', root])).toEqual({ code: 0, stdout: 'check-residue: 1 rows, 1 namings; 0 finding(s)\n', stderr: '' })
  })

  it('prints each finding, then the summary, and exits 1', () => {
    const root = project([kept('retired', 'src/kernel/a.ts', './retired/x', 1), kept('circle', 'src/kernel/a.ts', './circle/gone', 1)], {
      'src/kernel/a.ts': "export const x = ['./circle/x', './circle/x']\n",
    })
    expect(run(['--root', root])).toEqual({
      code: 1,
      stdout:
        'NEW src/kernel/a.ts [circle] "./circle/x" x2: the kernel names a capability; remove it, or add a row with its reason\n' +
        'STALE src/kernel/a.ts [circle] "./circle/gone": the kernel no longer names this; delete the row\n' +
        'check-residue: 2 rows, 2 namings; 1 for an id not in the manifest, ignored; 2 finding(s)\n',
      stderr: '',
    })
  })

  it('says how to call it when an argument is wrong, and exits 2', () => {
    expect(run(['--nope'])).toEqual({ code: 2, stdout: '', stderr: 'check-residue: unknown argument "--nope"\nusage: node scripts/check-residue.mjs [--root <dir>]\n' })
  })

  it('says what it could not read, and exits 2', () => {
    const root = tree({ 'src/kernel/a.ts': '' })
    expect(run(['--root', root])).toEqual({
      code: 2,
      stdout: '',
      stderr: `check-residue: ENOENT: no such file or directory, open '${path.join(root, 'capabilities.manifest.json')}'\n`,
    })
  })

  it.each([
    [null, 'null'],
    ['a plain string', 'a plain string'],
  ])('says what was thrown when it is no error: %s', async (cause, said) => {
    vi.doMock('node:fs', async (importOriginal) => ({
      ...(await importOriginal()),
      readFileSync: () => {
        throw cause
      },
    }))
    vi.resetModules()
    const throwing = await import('./check-residue.mjs')
    expect(run(['--root', tree({ 'src/kernel/a.ts': '' })], throwing.main)).toEqual({ code: 2, stdout: '', stderr: `check-residue: ${said}\n` })
  })

  /* The guard, in-process: whether this file is the one node started is `isProcessEntry`'s
     to say, and has its own tests; here it is told. */
  describe('run as a program', () => {
    const ARGV = process.argv
    afterEach(() => {
      process.argv = ARGV
      process.exitCode = undefined
      vi.doUnmock('./lib/entry.mjs')
    })
    const load = async (entry, argv) => {
      vi.doMock('./lib/entry.mjs', () => ({ isProcessEntry: () => entry }))
      process.argv = argv
      const printed = capture()
      vi.resetModules()
      await import('./check-residue.mjs')
      return { code: process.exitCode, ...printed() }
    }

    it('runs on the arguments after the script, and sets the exit code', async () => {
      const root = project([], { 'src/kernel/a.ts': "export const x = './circle/x'\n" })
      expect(await load(true, [process.execPath, 'scripts/check-residue.mjs', '--root', root])).toEqual({
        code: 1,
        stdout: 'NEW src/kernel/a.ts [circle] "./circle/x" x1: the kernel names a capability; remove it, or add a row with its reason\ncheck-residue: 0 rows, 1 namings; 1 finding(s)\n',
        stderr: '',
      })
    })

    it('does nothing when imported', async () => {
      expect(await load(false, [process.execPath, 'scripts/check-residue.mjs', '--nope'])).toEqual({ code: undefined, stdout: '', stderr: '' })
    })
  })

  it('passes on this tree, whose allow-list matches it', () => {
    const { code, stdout, stderr } = run([])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout).toMatch(/^check-residue: [1-9]\d* rows, [1-9]\d* namings; 0 finding\(s\)\n$/)
  })
})
