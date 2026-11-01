import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { isProcessEntry } from './lib/entry.mjs'
import { followHolders, isDestructuringTarget, keyText, staticText, unwrapped } from './lib/holders.mjs'

/**
 * `pnpm residue:check` — the kernel may not know a capability's name unless a
 * row here says why.
 *
 * A STATIC CHECK WITH NAMED LIMITS, not a proof: it reads syntax and scopes, with no
 * types resolved across a file. A clean run says none of the forms below is present;
 * WHAT IT CANNOT SEE lists what a clean run does not cover.
 *
 * `boundaries` refuses a kernel IMPORT of a capability, and that is all it can
 * see. A capability can be cut by `capability:remove` while the kernel still
 * holds its storage path, its service slot or its confinement rule, and every
 * other gate stays green, because a name is not an edge. So this reads what the
 * kernel names and compares it against an allow-list, in which each row carries
 * its reason.
 *
 * WHAT COUNTS AS NAMING, and it is deliberately not the bare word: `cards` alone
 * hits 130 times in 21 files and is ordinary kernel vocabulary, and `peer` and
 * `voices` are parameter names. For a manifest id `<id>`:
 *
 *   - a literal holding it as a path segment: `./circle/log`, `/circle`, `sync/x`;
 *   - a literal with `<id>:` or `<id>.` at its start or after a slash:
 *     `sync:presence`, `/public.jsonl`;
 *   - `services.<id>`, however it is reached: `ctx['services']['circle']`,
 *     `(env.services!).circle`, `const { circle } = env.services`,
 *     `({ services: { circle } }) => …`, `const s = env.services; s.circle`,
 *     `(s: KernelServices) => s.circle`, `getServices().circle`, `all[0].circle` for
 *     `all = [env.services]`, `Reflect.get(s, 'circle')`, and a key that folds to the
 *     id. `lib/holders.mjs` has the whole of what is followed through a file, and
 *     `typeReader` the whole of what counts as the services' type;
 *   - `<id>` as a key of an object VALUE or of a class, however it is written:
 *     `circle: { … }`, `{ circle }`, `{ ['cir' + 'cle']: … }`, `circle() {}`,
 *     `get circle() {}`, `class C { circle = 1 }`. A member of a type is not one, since
 *     a type holds no behaviour for a cut capability to orphan;
 *   - `<id>` as an enum member (`circle:`) or a JSX attribute (`circle=`);
 *   - any of those in a join that reads as one, as far as its constants go:
 *     `'cir' + 'cle/x'`, `${CIRCLE_DIR}/${id}`.
 *
 * WHAT IT CANNOT FOLLOW IT REFUSES, under the id `(unfollowed)`, which takes a row with
 * a reason like any other: a key nothing can read (`services[key]`), every key at once
 * (`Object.keys(services)`), the services returned from a method or a callback,
 * assigned to a member, or inside an object or array that goes on from where it was
 * made, a type that holds them in a way this cannot see through (`Box<KernelServices>`
 * for a box with a `value`, `Map<string, KernelServices>`), and the services handed to a
 * call or a prop whose far side does not take them where this reads them. A hand-on is
 * followed when it calls a function the kernel declares, by the name it was imported
 * under, and that function's parameter there is called `services` or typed
 * `KernelServices`; every declaration of that name must agree. `{ circle: X }` as the
 * parameter is what this refusal is for. The services may cross a
 * file only under a name that says so, because that is all the far side can be read
 * by: `services`, a function ending in `Services`, or `KernelServices`. So a member
 * typed as them, an export or an import that renames them, is refused too.
 *
 * WHAT IT CANNOT SEE, each because nothing here could decide it:
 *
 *   - a key or a name built from what is not a constant, on an object that is not the
 *     services: `{ [k]: v }`, `'cir' + x`. Any object can be built that way, and nothing
 *     says which of them matter;
 *   - a capability's name in JSX text, a comment, or a type member, which are no
 *     behaviour to orphan.
 *
 * A literal equal to the id and nothing more (`'circle'`) is not matched: the
 * shapes above are the ones the plan fixed, and `core/capability.ts` shows why a
 * bare token needs care, since its icon list holds ordinary words.
 *
 * THE SOURCE IS PARSED, NOT REGEXED, because the shared `stripComments` is a
 * small lexer that takes an apostrophe in JSX text for an opening quote, and from
 * there can read a real string as code and drop the rest of its line. A comment
 * is not a node here, so there is nothing to strip. Tests and test kits are not
 * read: they ship nothing, and `boundaries` holds what they import.
 *
 * A RATCHET, IN BOTH DIRECTIONS. A match with no row, or more matches than the
 * row's `count`, is a finding. So is a row whose matches have gone (`STALE`), or
 * the allow-list could only grow. The one exception is a row for an id the
 * manifest does not declare: `verify:without <id>` cuts the id and may not touch
 * the kernel, so the name stays where it was and is no longer anybody's. Such a
 * row is inert, because only manifest ids are ever searched, and it is counted in
 * the summary.
 *
 * Findings one per line, then a summary; exit 0 when clean, 1 on a finding, 2 on
 * a usage error or an unreadable input.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const USAGE = 'usage: node scripts/check-residue.mjs [--root <dir>]'
const MANIFEST = 'capabilities.manifest.json'
const KERNEL = 'src/kernel'
export const ALLOW_LIST = 'scripts/residue-allowlist.json'
/** The id of a finding that names no capability: the services went where this cannot follow. */
export const UNFOLLOWED = '(unfollowed)'

const isSource = (file) => /\.tsx?$/.test(file) && !/\.(test|testkit)\.tsx?$/.test(file) && !file.endsWith('.d.ts')

function sourcesUnder(dir, into = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) sourcesUnder(full, into)
    else if (isSource(full)) into.push(full)
  }
  return into
}

/** The literal's text, for every node that holds some, or null. */
function literalText(node) {
  return ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ? node.text
    : null
}

/* WHAT A TYPE SAYS OF ITS VALUE. Its members are the services'; its elements are the
   services; calling it gives the services; or it has them somewhere this cannot reach. */
const MEMBERS = 'members'
const ELEMENTS = 'elements'
const RETURNS = 'returns'
const HOLDS = 'holds'
const STRONGEST_FIRST = [MEMBERS, ELEMENTS, RETURNS, HOLDS]

/* The utilities whose result has the members of their first argument. */
const MEMBER_KEEPING = new Set(['Pick', 'Omit', 'Partial', 'Required', 'Readonly', 'NonNullable', 'Promise', 'PromiseLike', 'Awaited'])
const ELEMENT_KEEPING = new Set(['Array', 'ReadonlyArray', 'Set', 'ReadonlySet'])
const ENDS_IN_SERVICES = /services$/i

const strongest = (kinds) => STRONGEST_FIRST.find((kind) => kinds.includes(kind)) ?? null
/** What a container's elements make of it. */
const holding = (inner) => (inner === null ? null : inner === MEMBERS ? ELEMENTS : HOLDS)
const lastName = (name) => {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isQualifiedName(name)) return name.right.text
  return ts.isPropertyAccessExpression(name) ? name.name.text : null
}
const isTypeDeclaration = (node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassLike(node)

/**
 * What the kernel's types say of the services, for any file's type node.
 *
 * A generic is read through its body wherever the kernel declares it: `Local<T> = T | null`
 * has the members of `T`, and `Box<T> = { value: T }` has them under a key. A generic this
 * cannot see into is HOLDS rather than a guess, since calling it the services would miss
 * `ref.current.circle`, and calling it nothing would miss everything. A name declared twice
 * is whichever says the most.
 */
function typeReader(checker, sources) {
  const declared = new Map()
  const renamed = new Map()
  for (const source of sources) {
    for (const statement of source.statements) {
      if (isTypeDeclaration(statement) && statement.name) declared.set(statement.name.text, [...(declared.get(statement.name.text) ?? []), statement])
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) if (element.propertyName) renamed.set(element.name.text, element.propertyName.text)
      }
    }
  }

  const throughRenames = (name) => {
    const seen = new Set()
    let called = name
    while (renamed.has(called) && !seen.has(called)) {
      seen.add(called)
      called = renamed.get(called)
    }
    return called
  }
  const originalName = (name) => {
    let called = lastName(name)
    if (ts.isIdentifier(name)) {
      const declarations = checker.getSymbolAtLocation(name)?.declarations ?? []
      const imported = declarations.find(ts.isImportSpecifier)
      const assigned = declarations.find(ts.isImportEqualsDeclaration)
      if (imported !== undefined) called = (imported.propertyName ?? imported.name).text
      else if (assigned !== undefined && !ts.isExternalModuleReference(assigned.moduleReference)) called = lastName(assigned.moduleReference)
    }
    return throughRenames(called)
  }

  const ownMembers = (members, bound, seen) => {
    if (bound.size === 0) return null
    const held = members.some((member) => member.type !== undefined && !ts.isMethodSignature(member) && classify(member.type, bound, seen) !== null && (member.name === undefined || keyText(member.name, checker) !== 'services'))
    return held ? HOLDS : null
  }

  const ofDeclaration = (declaration, args, bound, seen) => {
    if (seen.has(declaration)) return null
    const next = new Set(seen).add(declaration)
    const parameters = new Map(
      (declaration.typeParameters ?? []).map((parameter, index) => {
        const given = args[index] ?? parameter.default
        return [parameter.name.text, given === undefined ? null : classify(given, args[index] === undefined ? new Map() : bound, next)]
      }),
    )
    if (ts.isTypeAliasDeclaration(declaration)) return classify(declaration.type, parameters, next)
    const inherited = (declaration.heritageClauses ?? []).filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword).flatMap((clause) => [...clause.types])
    return strongest(inherited.map((type) => classify(type, parameters, next))) ?? ownMembers(declaration.members, parameters, next)
  }

  const reference = (type, name, bound, seen) => {
    const called = originalName(name)
    if (called === null) return null
    const args = type.typeArguments ?? []
    if (bound.has(called)) return bound.get(called)
    if (called === 'KernelServices') return MEMBERS
    if (called === 'ReturnType') return args[0] !== undefined && ts.isTypeQueryNode(args[0]) && returnsServices(lastName(args[0].exprName) ?? '') ? MEMBERS : null
    if (MEMBER_KEEPING.has(called)) return args[0] === undefined ? null : classify(args[0], bound, seen)
    if (ELEMENT_KEEPING.has(called)) return args[0] === undefined ? null : holding(classify(args[0], bound, seen))
    const here = (checker.getSymbolAtLocation(name)?.declarations ?? [])
    const parameter = here.find(ts.isTypeParameterDeclaration)
    if (parameter !== undefined) return parameter.constraint === undefined ? null : classify(parameter.constraint, bound, seen)
    const local = here.filter(isTypeDeclaration)
    const found = local.length > 0 ? local : declared.get(called) ?? []
    if (found.length === 0) return strongest(args.map((arg) => classify(arg, bound, seen))) === null ? null : HOLDS
    return strongest(found.map((declaration) => ofDeclaration(declaration, args, bound, seen)))
  }

  const classify = (type, bound = new Map(), seen = new Set()) => {
    if (ts.isParenthesizedTypeNode(type)) return classify(type.type, bound, seen)
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return strongest(type.types.map((one) => classify(one, bound, seen)))
    if (ts.isConditionalTypeNode(type)) return strongest([classify(type.trueType, bound, seen), classify(type.falseType, bound, seen)])
    if (ts.isTypeOperatorNode(type)) return type.operator === ts.SyntaxKind.ReadonlyKeyword ? classify(type.type, bound, seen) : null
    if (ts.isArrayTypeNode(type)) return holding(classify(type.elementType, bound, seen))
    if (ts.isTupleTypeNode(type)) return holding(strongest(type.elements.map((one) => classify(ts.isNamedTupleMember(one) || ts.isRestTypeNode(one) || ts.isOptionalTypeNode(one) ? one.type : one, bound, seen))))
    if (ts.isFunctionTypeNode(type)) return classify(type.type, bound, seen) === MEMBERS ? RETURNS : null
    if (ts.isTypeQueryNode(type)) return lastName(type.exprName) === 'services' ? MEMBERS : null
    if (ts.isTypeLiteralNode(type)) return ownMembers(type.members, bound, seen)
    if (ts.isTypeReferenceNode(type)) return reference(type, type.typeName, bound, seen)
    if (ts.isExpressionWithTypeArguments(type)) return reference(type, type.expression, bound, seen)
    if (ts.isImportTypeNode(type)) return type.qualifier === undefined ? null : reference(type, type.qualifier, bound, seen)
    return null
  }

  /* A FUNCTION THE KERNEL DECLARES says for itself what it takes and what it returns, and
     across a file its name is what connects a call to it. */
  const functions = new Map()
  for (const source of sources) {
    for (const statement of source.statements) {
      const named = ts.isFunctionDeclaration(statement) && statement.name
        ? [[statement.name.text, statement]]
        : ts.isVariableStatement(statement)
          ? statement.declarationList.declarations
              .filter((one) => ts.isIdentifier(one.name) && one.initializer !== undefined && isFunctionLike(unwrapped(one.initializer)))
              .map((one) => [one.name.text, unwrapped(one.initializer)])
          : []
      for (const [name, fn] of named) functions.set(name, [...(functions.get(name) ?? []), fn])
    }
  }
  /* `readServices()` is a list of descriptors, whatever its name suggests. A declared type
     with nothing of the services in it outranks the name; no type leaves the name to speak. */
  const returnsServices = (name) => {
    if (!ENDS_IN_SERVICES.test(name)) return false
    const declaredFns = functions.get(name) ?? []
    return declaredFns.length === 0 || !declaredFns.every((fn) => fn.type !== undefined && classify(fn.type) === null)
  }
  const takesServices = (name, index) => {
    const declaredFns = functions.get(name) ?? []
    return declaredFns.length > 0 && declaredFns.every((fn) => {
      const parameter = fn.parameters[index]
      if (parameter === undefined || parameter.dotDotDotToken !== undefined) return false
      return (ts.isIdentifier(parameter.name) && parameter.name.text === 'services') || (parameter.type !== undefined && classify(parameter.type) === MEMBERS)
    })
  }
  /* A file with no word for them holds them only under an alias the kernel declares. */
  const aliases = [...declared.entries()].filter(([, declarations]) => strongest(declarations.map((one) => ofDeclaration(one, [], new Map(), new Set()))) !== null).map(([name]) => name)
  const names = [...aliases, ...[...renamed.keys()].filter((name) => ['KernelServices', ...aliases].includes(throughRenames(name)))]
  const mentions = names.length === 0 ? /services/i : new RegExp(`services|\\b(?:${names.map((name) => name.replace(/\$/g, '\\$')).join('|')})\\b`, 'i')
  return { classify, returnsServices, takesServices, mightHold: (text) => mentions.test(text) }
}

/* EVERY ESCAPE IS REFUSED BUT THESE, so one the engine learns later is loud by default.
   Rendering them or writing them into a string reads no member, so nothing is named. */
const READS_NOTHING = new Set(['rendered', 'written into a string'])

const SERVICES = Object.freeze({ kind: 'services' })
const isWrapperNode = (node) => ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)
const isExported = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
const isFunctionLike = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
/** The text a row quotes for what could not be followed: short, and on one line. */
const quoted = (node) => node.getText().replace(/\s+/g, ' ').slice(0, 60)

const isClassMember = (node) =>
  ((ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && ts.isClassLike(node.parent)) ||
  (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent))

const isObjectMember = (node) =>
  (ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)) &&
  ts.isObjectLiteralExpression(node.parent) &&
  !isDestructuringTarget(node.parent)

const isPlus = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
/** A `+` or a template that nothing outside it goes on building. */
const isWholeJoin = (node) => {
  if (!ts.isTemplateExpression(node) && !isPlus(node)) return false
  let outside = node.parent
  while (isWrapperNode(outside)) outside = outside.parent
  return !isPlus(outside) && !ts.isTemplateSpan(outside)
}
/** The parts of a join, in order: the text of each constant, and null for the rest. */
function joinedParts(node, checker) {
  const inner = unwrapped(node)
  if (ts.isTemplateExpression(inner)) return [inner.head.text, ...inner.templateSpans.flatMap((span) => [...joinedParts(span.expression, checker), span.literal.text])]
  if (isPlus(inner)) return [...joinedParts(inner.left, checker), ...joinedParts(inner.right, checker)]
  return [staticText(inner, checker)]
}
/** A join's stretches of constant text, each read as a literal would be, and the whole, for a row to quote. */
function readJoin(node, checker) {
  const runs = []
  let run = null
  for (const part of joinedParts(node, checker)) {
    if (part === null) {
      if (run !== null) runs.push(run)
      run = null
    } else run = (run ?? '') + part
  }
  if (run !== null) runs.push(run)
  return { runs, whole: joinedParts(node, checker).map((part) => part ?? '${…}').join('') }
}

/**
 * Every naming of an id in one file: `{ id, match }`, one per occurrence. `match` is
 * what a row quotes: the literal's whole text, `services.<id>`, `<id>:` or `<id>=`.
 *
 * WHAT HOLDS THE SERVICES is `followHolders`' to settle: an expression ending in the name,
 * a call whose name ends in `Services`, a binding of the kernel's services type, and
 * whatever was filled from one of those.
 */
function namingsIn(source, checker, ids, types) {
  const known = new Set(ids)
  const found = []
  const inLiteral = ids.map((id) => ({ id, shape: new RegExp(`(?:^|/)${id}(?:[:./]|$)`) }))
  const say = (at, how) => found.push({ id: UNFOLLOWED, match: `${how}: ${quoted(at)}` })

  if (types.mightHold(source.text)) followServices(source, checker, known, types, found, say)

  const hasPartNaming = (node) => {
    const literal = literalText(node)
    if (literal !== null && inLiteral.some(({ id, shape }) => literal !== id && shape.test(literal))) return true
    return ts.forEachChild(node, hasPartNaming) ?? false
  }
  const visit = (node) => {
    const literal = literalText(node)
    if (literal !== null) {
      /* The id alone, with no slash and nothing after it, is the bare token. */
      for (const { id, shape } of inLiteral) if (literal !== id && shape.test(literal)) found.push({ id, match: literal })
    }
    /* `'cir' + 'cle/x'` and `${DIR}/${x}` are said once, by the whole. A part that says it already does. */
    if (isWholeJoin(node) && !hasPartNaming(node)) {
      const { runs, whole } = readJoin(node, checker)
      for (const { id, shape } of inLiteral) if (runs.some((run) => run !== id && shape.test(run))) found.push({ id, match: whole })
    }
    if (isObjectMember(node) || isClassMember(node) || ts.isEnumMember(node)) {
      const key = keyText(node.name, checker)?.replace(/^#/, '')
      if (key !== undefined && known.has(key)) found.push({ id: key, match: `${key}:` })
    }
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && known.has(node.name.text)) found.push({ id: node.name.text, match: `${node.name.text}=` })
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** What `namingsIn` says of the services themselves. */
function followServices(source, checker, known, types, found, say) {
  const { classify, returnsServices, takesServices } = types
  /* Only a bare name is the function the kernel declares: `other.readServices()` may be
     anything, so the name speaks for it. */
  const namedForServices = (expression) => (ts.isIdentifier(expression) ? returnsServices(expression.text) : ENDS_IN_SERVICES.test(lastName(expression) ?? ''))
  const importedName = (callee) => {
    if (ts.isIdentifier(callee)) {
      const imported = checker.getSymbolAtLocation(callee)?.declarations?.find(ts.isImportSpecifier)
      return imported === undefined ? null : (imported.propertyName ?? imported.name).text
    }
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null
    return checker.getSymbolAtLocation(callee.expression)?.declarations?.some(ts.isNamespaceImport) ? callee.name.text : null
  }
  const seeds = []
  const elementSeeds = []
  const returning = []
  const returningSymbol = (symbol) => {
    if (symbol !== undefined) returning.push([symbol, [SERVICES]])
  }
  const symbolOfFunction = (fn) => {
    if (ts.isFunctionDeclaration(fn)) return fn.name === undefined ? undefined : checker.getSymbolAtLocation(fn.name)
    let at = fn
    while (isWrapperNode(at.parent)) at = at.parent
    return ts.isVariableDeclaration(at.parent) && ts.isIdentifier(at.parent.name) ? checker.getSymbolAtLocation(at.parent.name) : undefined
  }
  const collect = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node.type) {
      const kind = classify(node.type)
      if (kind === MEMBERS) seeds.push([node.name, [SERVICES]])
      if (kind === ELEMENTS) elementSeeds.push([node.name, [SERVICES]])
      if (kind === RETURNS && ts.isIdentifier(node.name)) returningSymbol(checker.getSymbolAtLocation(node.name))
    }
    /* `const g = getServices`, whose call then says what it is. */
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && !ENDS_IN_SERVICES.test(node.name.text)) {
      const value = unwrapped(node.initializer)
      const called = ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) ? lastName(value) : null
      if (called !== null && called !== 'services' && namedForServices(value)) returningSymbol(checker.getSymbolAtLocation(node.name))
    }
    if (isFunctionLike(node) && node.type && classify(node.type) === MEMBERS) returningSymbol(symbolOfFunction(node))
    if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || (ts.isParameter(node) && ts.isParameterPropertyDeclaration(node, node.parent))) && node.type) {
      const kind = classify(node.type)
      const key = keyText(node.name, checker)
      if (kind === MEMBERS && key !== 'services') say(node, 'a member holding the services under another name')
      if (kind === ELEMENTS) say(node, 'a member holding the services in an array')
      if (kind === RETURNS && !ENDS_IN_SERVICES.test(key ?? '')) say(node, 'a member returning the services under another name')
    }
    if ((ts.isMethodSignature(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && node.type && classify(node.type) === MEMBERS && !ENDS_IN_SERVICES.test(keyText(node.name, checker) ?? '')) {
      say(node.name, 'a method returning the services under another name')
    }
    if ((ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node) || ts.isArrayTypeNode(node) || ts.isTupleTypeNode(node)) && classify(node) === HOLDS) {
      say(node, 'a type holding the services where this cannot see them')
      return
    }
    ts.forEachChild(node, collect)
  }
  collect(source)

  const followed = followHolders({
    source,
    checker,
    rootName: 'services',
    rootOrigin: SERVICES,
    rootOf: (inner, node) => {
      for (let at = node; isWrapperNode(at); at = at.expression) {
        if (at.type !== undefined && classify(at.type) === MEMBERS) return [SERVICES]
      }
      if (!ts.isCallExpression(inner)) return []
      const callee = unwrapped(inner.expression)
      return (ts.isIdentifier(callee) || ts.isPropertyAccessExpression(callee)) && namedForServices(callee) ? [SERVICES] : []
    },
    seeds,
    elementSeeds,
    returning,
    read: (_origins, key, at) => {
      if (key === null) say(at, 'a key this cannot read')
      else if (known.has(key)) found.push({ id: key, match: `services.${key}` })
    },
    enumerated: (_origins, at) => say(at, 'every key of the services'),
    escaped: (_origins, at, how) => {
      if (!READS_NOTHING.has(how)) say(at, how)
    },
    handedOn: (callee, index) => index >= 0 && takesServices(importedName(callee), index),
  })

  /* WHAT LEAVES THE FILE leaves by name, and the far side has only that to go on. */
  const leaving = (name, symbol, at) => {
    if (symbol === undefined) return
    if (followed.returnsOf(symbol).length > 0 && !ENDS_IN_SERVICES.test(name)) say(at, 'a function returning the services, exported under another name')
    if (followed.heldBy(symbol).length > 0 && name !== 'services') say(at, 'the services, exported under another name')
  }
  const renames = (element) => {
    const from = element.propertyName?.text
    /* The type is `typeReader`'s, which can read a rename of it. */
    if (from === undefined || from === 'KernelServices' || element.name.text === from) return
    if (from === 'services' || (ENDS_IN_SERVICES.test(from) && !ENDS_IN_SERVICES.test(element.name.text))) say(element, 'the services under another name')
  }
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name) leaving(statement.name.text, checker.getSymbolAtLocation(statement.name), statement.name)
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) leaving(declaration.name.text, checker.getSymbolAtLocation(declaration.name), declaration.name)
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(unwrapped(statement.expression))) leaving('default', checker.getSymbolAtLocation(unwrapped(statement.expression)), statement)
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (statement.moduleSpecifier !== undefined) renames(element)
        else leaving(element.name.text, checker.getExportSpecifierLocalTargetSymbol(element), element)
      }
    }
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) renames(element)
    }
  }
}

/** Every naming under the kernel, as a map of `file\0id\0match` to its count. */
export function scan(root, ids) {
  const files = sourcesUnder(path.join(root, KERNEL))
  /* A walk that found nothing would report every row stale, or with no rows
     report clean. Neither is an answer. */
  if (files.length === 0) throw new Error(`${KERNEL}: no source files under ${root}`)
  /* ONE PROGRAM, for the scopes: no library and no resolving, since what crosses a file
     is by name, and `typeReader` reads the kernel's types for that. */
  const program = ts.createProgram(files, { noResolve: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.Latest, noEmit: true })
  const checker = program.getTypeChecker()
  const sources = files.map((full) => program.getSourceFile(full))
  const types = typeReader(checker, sources)
  const counts = new Map()
  for (const source of sources) {
    const file = path.relative(root, source.fileName).split(path.sep).join('/')
    for (const { id, match } of namingsIn(source, checker, ids, types)) {
      const key = JSON.stringify([file, id, match])
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

/** Rows from the allow-list's text. Throws on any shape it does not understand. */
export function parseAllowList(text) {
  const body = JSON.parse(text)
  if (!Array.isArray(body?.rows)) throw new Error(`${ALLOW_LIST}: no rows array`)
  const seen = new Set()
  for (const row of body.rows) {
    const where = `${ALLOW_LIST}: ${JSON.stringify(row)}`
    for (const field of ['id', 'file', 'match', 'reason']) {
      if (typeof row?.[field] !== 'string' || row[field].trim() === '') throw new Error(`${where}: needs a non-empty ${field}`)
    }
    if (!Number.isInteger(row.count) || row.count < 1) throw new Error(`${where}: count must be a positive integer`)
    const key = JSON.stringify([row.file, row.id, row.match])
    if (seen.has(key)) throw new Error(`${where}: duplicate row`)
    seen.add(key)
  }
  return body.rows
}

/** `{ findings, inert, occurrences }`, comparing a scan against the rows. */
export function compare(counts, rows, ids) {
  const known = new Set([...ids, UNFOLLOWED])
  const findings = []
  const remaining = new Map(counts)
  let inert = 0
  for (const row of rows) {
    if (!known.has(row.id)) {
      inert++
      continue
    }
    const key = JSON.stringify([row.file, row.id, row.match])
    const count = remaining.get(key) ?? 0
    remaining.delete(key)
    const named = `${row.file} [${row.id}] ${JSON.stringify(row.match)}`
    if (count === 0) findings.push(`STALE ${named}: the kernel no longer names this; delete the row`)
    else if (count !== row.count) findings.push(`COUNT ${named}: ${count} in the source, ${row.count} on the row`)
  }
  for (const [key, count] of remaining) {
    const [file, id, match] = JSON.parse(key)
    const what = id === UNFOLLOWED ? 'the kernel takes its services where this cannot follow; name the member, or' : 'the kernel names a capability; remove it, or'
    findings.push(`NEW ${file} [${id}] ${JSON.stringify(match)} x${count}: ${what} add a row with its reason`)
  }
  const occurrences = [...counts.values()].reduce((sum, count) => sum + count, 0)
  return { findings: findings.sort(), inert, occurrences }
}

/** `{ root }` or `{ error }`. Anything not understood is an error. */
export function parseArgs(argv, cwd = process.cwd()) {
  let root
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--root') return { error: `unknown argument ${JSON.stringify(argv[i])}` }
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) return { error: '--root needs a directory' }
    if (root !== undefined) return { error: '--root given twice' }
    root = path.resolve(cwd, value)
  }
  return { root: root ?? REPO_ROOT }
}

/** Exit code; prints findings and a summary. */
export function main(argv) {
  const args = parseArgs(argv)
  if ('error' in args) {
    process.stderr.write(`check-residue: ${args.error}\n${USAGE}\n`)
    return 2
  }
  let result
  let rows
  try {
    const manifest = JSON.parse(readFileSync(path.join(args.root, MANIFEST), 'utf8'))
    const ids = manifest.capabilities.map((entry) => entry.id)
    rows = parseAllowList(readFileSync(path.join(args.root, ALLOW_LIST), 'utf8'))
    result = compare(scan(args.root, ids), rows, ids)
  } catch (cause) {
    process.stderr.write(`check-residue: ${cause?.message ?? String(cause)}\n`)
    return 2
  }
  for (const finding of result.findings) process.stdout.write(`${finding}\n`)
  const inert = result.inert === 0 ? '' : `; ${result.inert} for an id not in the manifest, ignored`
  process.stdout.write(`check-residue: ${rows.length} rows, ${result.occurrences} namings${inert}; ${result.findings.length} finding(s)\n`)
  return result.findings.length === 0 ? 0 : 1
}

if (isProcessEntry(import.meta)) process.exitCode = main(process.argv.slice(2))
