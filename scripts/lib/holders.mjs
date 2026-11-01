import ts from 'typescript'

/**
 * What two syntactic gates share: following one kind of value through a file's
 * bindings, with the compiler's scopes and no types resolved.
 *
 * `check-residue` follows the kernel's services and `check-dead-css` follows a
 * stylesheet. They ask the same question of the same forms, and each used to carry
 * its own copy of the walk, with its own list of forms it could not see. The list
 * is one list, so the walk is one walk.
 *
 * A value is an ORIGIN, whatever the gate says it is. A binding can hold several,
 * and a read goes against each, because nothing here knows which branch ran.
 *
 * WHAT IS FOLLOWED, within one file, until nothing changes, because an alias can be
 * written above the one it copies:
 *
 *   - a declaration, a default, an assignment and a pattern, with its rest;
 *   - a conditional and a fallback: `x ? a : b`, `a ?? b`, `await a`;
 *   - an array: `[s] = [a]`, `const all = [a]; all[0]`, `for (const s of all)`,
 *     `all.map((s) => …)`;
 *   - an object bound to a name: `const o = { s: a }; o.s`, `o['s']`, and a spread,
 *     `{ ...a }`;
 *   - a function in the file bound to a name: what it returns, and what a call hands
 *     its parameters.
 *
 * WHAT IS NOT FOLLOWED IS SAID: as an `escape` with how it left, and a key this
 * cannot read as a read of `null`. A value inside an array or object that goes on
 * anywhere but a name, a method's return, a member assigned to, and a function that
 * returns the value handed on as a value are all escapes. Each gate decides what
 * those mean.
 */

/** `x`, `x!`, `(x)`, `x as T`, `<T>x`, `x satisfies T`: the expression under its wrappers. */
export function unwrapped(node) {
  let inner = node
  while (
    ts.isParenthesizedExpression(inner) ||
    ts.isNonNullExpression(inner) ||
    ts.isAsExpression(inner) ||
    ts.isTypeAssertionExpression(inner) ||
    ts.isSatisfiesExpression(inner)
  ) {
    inner = inner.expression
  }
  return inner
}

const isConstDeclaration = (declaration) => ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0

/**
 * The one string an expression can only be, or null: `'a'`, `` `a` ``, `'a' + 'b'`,
 * `` `${a}b` ``, a `const` holding one of those, and a key of a `const` object.
 */
export function staticText(node, checker, seen = new Set()) {
  const inner = unwrapped(node)
  if (ts.isStringLiteralLike(inner)) return inner.text
  if (ts.isTemplateExpression(inner)) {
    let text = inner.head.text
    for (const span of inner.templateSpans) {
      const part = staticText(span.expression, checker, seen)
      if (part === null) return null
      text += part + span.literal.text
    }
    return text
  }
  if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(inner.left, checker, seen)
    const right = left === null ? null : staticText(inner.right, checker, seen)
    return right === null ? null : left + right
  }
  if (ts.isIdentifier(inner)) {
    const declaration = checker.getSymbolAtLocation(inner)?.valueDeclaration
    if (declaration === undefined || seen.has(declaration) || !isConstDeclaration(declaration)) return null
    seen.add(declaration)
    return staticText(declaration.initializer, checker, seen)
  }
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(unwrapped(inner.expression))) {
    const declaration = checker.getSymbolAtLocation(unwrapped(inner.expression))?.valueDeclaration
    if (declaration === undefined || !isConstDeclaration(declaration)) return null
    const object = unwrapped(declaration.initializer)
    if (!ts.isObjectLiteralExpression(object)) return null
    const member = object.properties.find((one) => ts.isPropertyAssignment(one) && keyText(one.name, checker) === inner.name.text)
    return member === undefined ? null : staticText(member.initializer, checker, seen)
  }
  return null
}

/**
 * The keys an expression can be, `null` among them when one cannot be read:
 * `'a'`, `x ? 'a' : 'b'`, `x ?? 'a'`, and whatever `staticText` folds.
 */
export function staticKeys(node, checker) {
  const inner = unwrapped(node)
  if (ts.isConditionalExpression(inner)) return [...staticKeys(inner.whenTrue, checker), ...staticKeys(inner.whenFalse, checker)]
  if (ts.isBinaryExpression(inner) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(inner.operatorToken.kind)) {
    return [...staticKeys(inner.left, checker), ...staticKeys(inner.right, checker)]
  }
  /* `for (const k of ['a', 'b'])`: the variable has no initializer, and the list says what it is. */
  if (ts.isIdentifier(inner)) {
    const declaration = checker.getSymbolAtLocation(inner)?.valueDeclaration
    const loop = declaration !== undefined && ts.isVariableDeclaration(declaration) ? declaration.parent?.parent : undefined
    if (loop !== undefined && ts.isForOfStatement(loop) && ts.isArrayLiteralExpression(unwrapped(loop.expression))) {
      return unwrapped(loop.expression).elements.flatMap((element) => staticKeys(element, checker))
    }
  }
  return [staticText(inner, checker)]
}

/** The text of a key: `a`, `'a'`, `['a']`, `[K]` for a constant `K`. Null for `[k]`, which could be anything. */
export function keyText(name, checker) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isPrivateIdentifier(name)) return name.text
  return ts.isComputedPropertyName(name) ? staticText(name.expression, checker) : null
}

/** What a pattern's value assigns to: `s` in `{ a: s }` and in `{ a: s = {} }`. */
export function assignedTarget(node) {
  const inner = unwrapped(node)
  return ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsToken ? assignedTarget(inner.left) : inner
}

/** Whether an object or array literal is the left of an assignment, so its keys read rather than write. */
export function isDestructuringTarget(literal) {
  let node = literal
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent
  const parent = node.parent
  if (ts.isBinaryExpression(parent)) return parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === node
  if (ts.isArrayLiteralExpression(parent)) return isDestructuringTarget(parent)
  return ts.isPropertyAssignment(parent) && parent.initializer === node && isDestructuringTarget(parent.parent)
}

const isWrapper = (node) => ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)

const isExportedDeclaration = (declaration) => (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0

const PROMISE_METHODS = new Set(['then', 'catch', 'finally'])
const FALLBACKS = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken])
const ASSIGNMENTS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken])
/** The array methods whose result holds the elements it was called on. */
const KEEPS_ELEMENTS = new Set(['slice', 'filter', 'concat', 'reverse', 'sort', 'toSorted', 'toReversed'])
/** The array methods that call back with an element first. */
const CALLS_BACK = new Set(['map', 'flatMap', 'forEach', 'filter', 'find', 'findLast', 'some', 'every', 'sort', 'toSorted'])
/** The calls that read every key of what they are given. */
const ENUMERATES = new Set(['keys', 'values', 'entries', 'getOwnPropertyNames', 'getOwnPropertyDescriptors', 'ownKeys'])
/** The calls that read one key, named by their second argument. */
const READS_KEY = new Set(['get', 'has', 'getOwnPropertyDescriptor', 'hasOwn', 'hasOwnProperty'])

/* REACT'S OWN HOOKS compare a dependency list and read nothing out of it, so a value in
   one has not gone anywhere. A hook of anybody else's might do anything with an array. */
const DEPENDENCY_LISTS = new Map([['useEffect', 1], ['useLayoutEffect', 1], ['useInsertionEffect', 1], ['useMemo', 1], ['useCallback', 1], ['useImperativeHandle', 2]])
const isDependencyList = (call, argument) => {
  const callee = unwrapped(call.expression)
  const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null
  return called !== null && DEPENDENCY_LISTS.get(called) === call.arguments.indexOf(argument)
}

const isFunctionLike = (node) => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)

const enclosingFunction = (node) => {
  let at = node.parent
  while (at !== undefined && !isFunctionLike(at) && !ts.isMethodDeclaration(at) && !ts.isGetAccessorDeclaration(at) && !ts.isSetAccessorDeclaration(at) && !ts.isConstructorDeclaration(at)) at = at.parent
  return at !== undefined && isFunctionLike(at) ? at : null
}

const add = (map, key, origins) => {
  let added = false
  let held = map.get(key)
  for (const origin of origins) {
    if (held === undefined) {
      held = new Set()
      map.set(key, held)
    }
    if (!held.has(origin)) {
      held.add(origin)
      added = true
    }
  }
  return added
}

/**
 * Follow one kind of value through one file.
 *
 *   - `rootName`, `rootOrigin`: anything called this holds that origin, because it
 *     is what being handed the value looks like: `styles`, `env.services`.
 *   - `rootOf(inner, node)`: origins an expression holds for the gate's own reason,
 *     given it without its wrappers and with them.
 *   - `seeds`: `[target, origins]`, filled before anything runs.
 *   - `elementSeeds`: the same, for a name whose elements hold them.
 *   - `returning`: `[symbol, origins]`, a function known to return these.
 *   - `through(origins, keys)`: origins reached by a member that is not a read, like
 *     a namespace's `default`.
 *   - `read(origins, key, at)`: a member read, `key` null when it cannot be read.
 *   - `enumerated(origins, at)`: every member read.
 *   - `escaped(origins, at, how)`: the value left where this cannot follow.
 *   - `handedOn(callee, index, origins)`: a call to something not in this file, with
 *     the value as an argument. True when the gate follows it; false is an escape.
 *
 * Returns `originsOf`, `heldBy` and `returnsOf`, which hold once this has run.
 */
export function followHolders({
  source,
  checker,
  rootName,
  rootOrigin,
  rootOf,
  seeds = [],
  elementSeeds = [],
  returning = [],
  through = () => [],
  read,
  enumerated,
  escaped,
  handedOn,
}) {
  const direct = new Map()
  const elements = new Map()
  const returns = new Map(returning.map(([symbol, origins]) => [symbol, new Set(origins)]))
  const patternReads = new Map()
  const patternKeys = new Map()
  const allSeeds = [...seeds]
  /* A name bound to an object literal with a holder in it. Its keys are holders; this
     is for what happens to the name itself. */
  const objects = new Map()
  /* What each key of an object literal holds, by its declaration. */
  const keyed = new Map()
  /* A member's symbol asks the checker for the type of what it is read from, and that
     is the slow question, so it is asked only of names something here could answer. */
  const heldKeys = new Set()
  let changed = false

  /* In `{ s }` the name's own symbol is the key; the variable is what it means. */
  const symbolOf = (identifier) =>
    ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier ? checker.getShorthandAssignmentValueSymbol(identifier.parent) : checker.getSymbolAtLocation(identifier)

  const fnOfSymbol = (symbol) => {
    const declaration = symbol?.valueDeclaration
    if (declaration === undefined) return null
    if (ts.isFunctionDeclaration(declaration)) return declaration
    if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const value = unwrapped(declaration.initializer)
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return value
    }
    return null
  }
  const symbolOfFn = (fn) => {
    if (ts.isFunctionDeclaration(fn)) return fn.name === undefined ? null : checker.getSymbolAtLocation(fn.name)
    let at = fn
    while (isWrapper(at.parent)) at = at.parent
    return ts.isVariableDeclaration(at.parent) && ts.isIdentifier(at.parent.name) ? checker.getSymbolAtLocation(at.parent.name) : null
  }
  const calleeSymbol = (callee) => {
    const inner = unwrapped(callee)
    return ts.isIdentifier(inner) ? checker.getSymbolAtLocation(inner) : undefined
  }

  /* An object literal's type has its own symbol for each key, made when the type is
     asked for, so the key's declaration is what they share. */
  const heldBySymbol = (symbol) =>
    symbol === undefined ? [] : [...(direct.get(symbol) ?? []), ...(symbol.declarations ?? []).flatMap((at) => [...(keyed.get(at) ?? [])])]
  const memberOfType = (expression, key) => (key !== null && heldKeys.has(key) ? heldBySymbol(checker.getPropertyOfType(checker.getTypeAtLocation(expression), key)) : [])

  /** What a member of an object holds, when the checker can say which object. */
  const heldMember = (access, keys) => {
    if (heldKeys.size === 0) return []
    if (ts.isPropertyAccessExpression(access)) return heldKeys.has(access.name.text) ? heldBySymbol(checker.getSymbolAtLocation(access.name)) : []
    return keys.flatMap((key) => memberOfType(access.expression, key))
  }

  /** The origins an expression holds. */
  const originsOf = (node) => {
    const inner = unwrapped(node)
    const own = rootOf(inner, node)
    if (own.length > 0) return own
    if (ts.isIdentifier(inner)) {
      const held = direct.get(symbolOf(inner))
      if (held !== undefined) return [...held]
      return inner.text === rootName ? [rootOrigin] : []
    }
    if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
      const keys = ts.isPropertyAccessExpression(inner) ? [inner.name.text] : staticKeys(inner.argumentExpression, checker)
      const member = heldMember(inner, keys)
      if (member.length > 0) return member
      if (keys.includes(rootName)) return [rootOrigin]
      const via = through(originsOf(inner.expression), keys)
      if (via.length > 0) return via
      return ts.isElementAccessExpression(inner) ? elementsOf(inner.expression) : []
    }
    if (ts.isConditionalExpression(inner)) return [...originsOf(inner.whenTrue), ...originsOf(inner.whenFalse)]
    if (ts.isBinaryExpression(inner)) {
      if (FALLBACKS.has(inner.operatorToken.kind)) return [...originsOf(inner.left), ...originsOf(inner.right)]
      if (inner.operatorToken.kind === ts.SyntaxKind.CommaToken) return originsOf(inner.right)
      return []
    }
    if (ts.isAwaitExpression(inner)) return originsOf(inner.expression)
    if (ts.isObjectLiteralExpression(inner) && !isDestructuringTarget(inner)) {
      return inner.properties.flatMap((member) => (ts.isSpreadAssignment(member) ? originsOf(member.expression) : []))
    }
    if (ts.isCallExpression(inner)) {
      const fn = calleeSymbol(inner.expression)
      const held = fn === undefined ? undefined : returns.get(fn)
      return held === undefined ? [] : [...held]
    }
    return []
  }

  /** The origins an expression's elements hold. */
  const elementsOf = (node) => {
    const inner = unwrapped(node)
    if (ts.isArrayLiteralExpression(inner)) {
      return inner.elements.flatMap((element) => (ts.isSpreadElement(element) ? elementsOf(element.expression) : originsOf(element)))
    }
    if (ts.isIdentifier(inner)) return [...(elements.get(symbolOf(inner)) ?? [])]
    if (ts.isConditionalExpression(inner)) return [...elementsOf(inner.whenTrue), ...elementsOf(inner.whenFalse)]
    if (ts.isBinaryExpression(inner) && FALLBACKS.has(inner.operatorToken.kind)) return [...elementsOf(inner.left), ...elementsOf(inner.right)]
    if (ts.isAwaitExpression(inner)) return elementsOf(inner.expression)
    if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && KEEPS_ELEMENTS.has(inner.expression.name.text)) return elementsOf(inner.expression.expression)
    return []
  }

  const hold = (identifier, origins) => {
    const symbol = symbolOf(identifier)
    /* A member typed as the value, read later as `x.s`. */
    if (origins.length > 0) heldKeys.add(identifier.text)
    if (symbol !== undefined && add(direct, symbol, origins)) changed = true
  }
  const holdElements = (identifier, origins) => {
    const symbol = symbolOf(identifier)
    if (symbol !== undefined && add(elements, symbol, origins)) changed = true
  }
  /** One key of a pattern over a holder: a way through, or a read. */
  const patternKey = (at, key, origins, target) => {
    const via = key === null ? [] : through(origins, [key])
    if (via.length > 0) fill(target, via)
    else if (add(patternReads, at, origins)) {
      patternKeys.set(at, key)
      changed = true
    }
  }
  /** A declaration's name, or an assignment's target, taking these origins. */
  const fill = (target, origins) => {
    if (origins.length === 0) return
    if (ts.isIdentifier(target)) hold(target, origins)
    else if (ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) {
        if (element.dotDotDotToken) fill(element.name, origins)
        else patternKey(element, keyText(element.propertyName ?? element.name, checker), origins, element.name)
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const member of target.properties) {
        if (ts.isSpreadAssignment(member)) fill(unwrapped(member.expression), origins)
        else patternKey(member, keyText(member.name, checker), origins, ts.isPropertyAssignment(member) ? assignedTarget(member.initializer) : member.name)
      }
    }
  }
  /** A pattern over an object that holds one under a key: `const { s } = o`. */
  const fillFromKeys = (target, from) => {
    if (heldKeys.size === 0) return
    if (ts.isObjectBindingPattern(target)) {
      for (const element of target.elements) {
        if (!element.dotDotDotToken) fill(element.name, memberOfType(from, keyText(element.propertyName ?? element.name, checker)))
      }
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const member of target.properties) {
        if (!ts.isSpreadAssignment(member)) fill(ts.isPropertyAssignment(member) ? assignedTarget(member.initializer) : member.name, memberOfType(from, keyText(member.name, checker)))
      }
    }
  }
  const fillElements = (target, origins) => {
    if (origins.length === 0) return
    if (ts.isIdentifier(target)) holdElements(target, origins)
    else if (ts.isArrayBindingPattern(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue
        if (element.dotDotDotToken) fillElements(element.name, origins)
        else fill(element.name, origins)
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isSpreadElement(element)) fillElements(unwrapped(element.expression), origins)
        else fill(assignedTarget(element), origins)
      }
    }
  }

  const flows = []
  const fromElements = []
  const returned = []
  const calls = []
  const values = []
  const walk = (node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) flows.push([node.name, node.initializer])
    if (ts.isShorthandPropertyAssignment(node) && node.objectAssignmentInitializer) flows.push([node.name, node.objectAssignmentInitializer])
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken && keyText(node.propertyName ?? node.name, checker) === rootName) allSeeds.push([node.name, [rootOrigin]])
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && isDestructuringTarget(node.parent) && keyText(node.name, checker) === rootName) {
      allSeeds.push([assignedTarget(node.initializer), [rootOrigin]])
    }
    /* A key of an object VALUE, which is a holder for whoever reads it back: `o.s`. */
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && !isDestructuringTarget(node.parent)) values.push([node.name, node.initializer])
    if (ts.isShorthandPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent) && !isDestructuringTarget(node.parent)) values.push([node.name, node.name])
    if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind)) flows.push([unwrapped(node.left), node.right])
    if (ts.isForOfStatement(node)) {
      const target = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0].name : unwrapped(node.initializer)
      fromElements.push([target, node.expression])
    }
    if (ts.isReturnStatement(node) && node.expression) {
      const fn = enclosingFunction(node)
      if (fn !== null) returned.push([fn, node.expression])
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) returned.push([node, node.body])
    if (ts.isCallExpression(node)) calls.push(node)
    ts.forEachChild(node, walk)
  }
  walk(source)

  /** The function a call's callback runs: written there, or named in this file. */
  const callbackOf = (argument) => {
    const inner = unwrapped(argument)
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner
    return ts.isIdentifier(inner) ? fnOfSymbol(checker.getSymbolAtLocation(inner)) : null
  }

  /** The name an object literal is bound to, through any object it sits in, if it is. */
  const nameBinding = (literal) => {
    let here = literal
    for (;;) {
      while (isWrapper(here.parent)) here = here.parent
      const parent = here.parent
      if (ts.isPropertyAssignment(parent) && !isDestructuringTarget(parent.parent)) here = parent.parent
      else if (ts.isSpreadAssignment(parent) && !isDestructuringTarget(parent.parent)) here = parent.parent
      else return ts.isVariableDeclaration(parent) && parent.initializer === here && ts.isIdentifier(parent.name) ? parent.name : null
    }
  }

  do {
    changed = false
    for (const [target, origins] of allSeeds) fill(target, origins)
    for (const [target, origins] of elementSeeds) fillElements(target, origins)
    for (const [target, from] of flows) {
      fill(target, originsOf(from))
      fillElements(target, elementsOf(from))
      fillFromKeys(target, from)
    }
    for (const [target, from] of fromElements) fill(target, elementsOf(from))
    for (const [name, from] of values) {
      const origins = originsOf(from)
      if (origins.length === 0) continue
      const key = keyText(name, checker)
      if (key !== null) heldKeys.add(key)
      if (key !== null && add(keyed, name.parent, origins)) changed = true
      /* Under the root's own name, whoever gets the object can read it back by that name. */
      const bound = key === rootName ? null : nameBinding(name.parent.parent)
      if (bound !== null && add(objects, checker.getSymbolAtLocation(bound), origins)) changed = true
    }
    for (const [fn, from] of returned) {
      const symbol = symbolOfFn(fn)
      if (symbol !== null && symbol !== undefined && add(returns, symbol, originsOf(from))) changed = true
    }
    for (const call of calls) {
      const callee = unwrapped(call.expression)
      const fn = fnOfSymbol(calleeSymbol(callee))
      if (fn !== null) {
        fn.parameters.forEach((parameter, index) => {
          if (parameter.dotDotDotToken) {
            fillElements(parameter.name, call.arguments.slice(index).flatMap(originsOf))
            return
          }
          if (index >= call.arguments.length) return
          const argument = call.arguments[index]
          fill(parameter.name, originsOf(argument))
          fillElements(parameter.name, elementsOf(argument))
        })
      }
      if (!ts.isPropertyAccessExpression(callee)) continue
      const callback = call.arguments.length > 0 ? callbackOf(call.arguments[0]) : null
      const first = callback?.parameters[0]
      if (first === undefined) continue
      if (CALLS_BACK.has(callee.name.text)) fill(first.name, elementsOf(callee.expression))
      if (callee.name.text === 'then') fill(first.name, originsOf(callee.expression))
    }
  } while (changed)

  /* Holders are settled: what each is used for can be said once, and only once. */
  for (const [at, origins] of patternReads) read([...origins], patternKeys.get(at), at)

  const isName = (node) => {
    const parent = node.parent
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node) ||
      ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isTypeParameterDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent)) && (parent.name === node || parent.propertyName === node)) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isJsxAttribute(parent) ||
      ts.isJsxOpeningElement(parent) ||
      ts.isJsxClosingElement(parent) ||
      ts.isJsxSelfClosingElement(parent) ||
      ts.isTypeReferenceNode(parent) ||
      ts.isQualifiedName(parent) ||
      ts.isTypeQueryNode(parent) ||
      ts.isExpressionWithTypeArguments(parent) ||
      (ts.isShorthandPropertyAssignment(parent) && isDestructuringTarget(parent.parent)) ||
      ts.isLabeledStatement(parent)
    )
  }

  /** What becomes of a value at `node`, once the wrappers around it are climbed. */
  const useOf = (node) => {
    let here = node
    while (isWrapper(here.parent) || ts.isAwaitExpression(here.parent)) here = here.parent
    const parent = here.parent
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === here) return null
    if (ts.isElementAccessExpression(parent)) return null
    if (ts.isConditionalExpression(parent)) return parent.condition === here ? null : useOf(parent)
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind
      if (FALLBACKS.has(operator)) return useOf(parent)
      if (operator === ts.SyntaxKind.CommaToken) return parent.right === here ? useOf(parent) : null
      if (ASSIGNMENTS.has(operator) && parent.right === here) return assignedUse(parent)
      return null
    }
    if (ts.isPropertyAssignment(parent)) {
      if (isDestructuringTarget(parent.parent)) return null
      const key = keyText(parent.name, checker)
      if (key === null) return 'held under a key this cannot read'
      return key === rootName ? null : namedOrOut(parent.parent, 'held by an object')
    }
    if (ts.isShorthandPropertyAssignment(parent)) {
      if (parent.objectAssignmentInitializer === here) return null
      return parent.name.text === rootName ? null : namedOrOut(parent.parent, 'held by an object')
    }
    if (ts.isSpreadAssignment(parent)) return isDestructuringTarget(parent.parent) ? null : namedOrOut(parent.parent, 'spread into an object')
    if (ts.isSpreadElement(parent)) {
      if (!ts.isArrayLiteralExpression(parent.parent)) return 'spread into a call'
      return isDestructuringTarget(parent.parent) ? null : namedOrOut(parent.parent, 'spread into an array')
    }
    if (ts.isArrayLiteralExpression(parent)) return isDestructuringTarget(parent) ? null : namedOrOut(parent, 'held by an array')
    if (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) return null
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return null
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression === here ? null : argumentUse(parent, here)
    if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === here)) {
      const fn = ts.isArrowFunction(parent) ? parent : enclosingFunction(parent)
      const symbol = fn === null ? null : symbolOfFn(fn)
      return symbol === null || symbol === undefined ? 'returned' : null
    }
    /* An export is the gate's to follow: it can see the other side of one. */
    if (ts.isExportAssignment(parent)) return null
    if (ts.isJsxExpression(parent)) {
      if (ts.isJsxAttribute(parent.parent)) return parent.parent.name.getText() === rootName ? null : 'handed as a prop'
      return 'rendered'
    }
    if (ts.isJsxSpreadAttribute(parent)) return 'spread into props'
    if (ts.isTemplateSpan(parent)) return 'written into a string'
    if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isPrefixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || ts.isExpressionStatement(parent) || ts.isDeleteExpression(parent) || ts.isVoidExpression(parent)) return null
    return 'used'
  }
  /** `x = value`: followed into a name or a pattern, and not into a member, whoever reads that. */
  const assignedUse = (assignment) => {
    const target = unwrapped(assignment.left)
    if (ts.isIdentifier(target) || ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) return null
    const key = ts.isPropertyAccessExpression(target) ? target.name.text : null
    return key === rootName ? null : 'assigned to a member'
  }
  /**
   * A value inside an object or an array: followed while a name in this file holds
   * that, and gone wherever else it goes. A return is gone too. The caller gets it
   * back with nothing to say which key it came under.
   */
  const namedOrOut = (container, how) => {
    let here = container
    while (isWrapper(here.parent)) here = here.parent
    const parent = here.parent
    if (ts.isVariableDeclaration(parent) && parent.initializer === here) return isExportedDeclaration(parent) ? how : null
    if (ts.isBinaryExpression(parent) && ASSIGNMENTS.has(parent.operatorToken.kind) && parent.right === here) return assignedUse(parent) === null ? null : how
    if (ts.isForOfStatement(parent) && parent.expression === here) return null
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === here) return null
    if (ts.isCallExpression(parent) && isDependencyList(parent, here)) return null
    if (ts.isObjectLiteralExpression(container) && ts.isPropertyAssignment(parent) && !isDestructuringTarget(parent.parent) && keyText(parent.name, checker) !== null) return namedOrOut(parent.parent, how)
    return how
  }
  /** What becomes of a NAME holding an object or an array with the value inside. */
  const containerUse = (node) => {
    let here = node
    while (isWrapper(here.parent) || ts.isAwaitExpression(here.parent)) here = here.parent
    const parent = here.parent
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === here) return null
    if (ts.isForOfStatement(parent) && parent.expression === here) return null
    if (ts.isForInStatement(parent)) return null
    if (ts.isVariableDeclaration(parent) && parent.initializer === here) return isExportedDeclaration(parent) ? 'exported in an array or object' : null
    if (ts.isBinaryExpression(parent) && ASSIGNMENTS.has(parent.operatorToken.kind)) return parent.left === here || assignedUse(parent) === null ? null : 'assigned to a member'
    if (ts.isSpreadElement(parent) && ts.isArrayLiteralExpression(parent.parent)) return namedOrOut(parent.parent, 'spread into an array')
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(unwrapped(parent.expression)) && ts.isIdentifier(unwrapped(parent.expression).expression) && ['Object', 'Reflect'].includes(unwrapped(parent.expression).expression.text)) {
      const name = unwrapped(parent.expression).name.text
      if (ENUMERATES.has(name) || READS_KEY.has(name)) return null
    }
    return 'handed on in an array or object'
  }
  const argumentUse = (call, argument) => {
    const callee = unwrapped(call.expression)
    if (ts.isCallExpression(call)) {
      if (fnOfSymbol(calleeSymbol(callee)) !== null) return null
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ['Object', 'Reflect'].includes(callee.expression.text) && (ENUMERATES.has(callee.name.text) || READS_KEY.has(callee.name.text))) return null
    }
    return handedOn(callee, call.arguments.indexOf(argument), originsOf(argument)) ? null : 'handed to a call'
  }

  /* `const styles = getComputedStyle(el)` is called what being handed a stylesheet
     looks like and was made here from something else. A read of it keeps a class
     alive as any other does; handing it on says nothing about a stylesheet. */
  const isLocalOfTheRootName = (expression) => {
    const node = unwrapped(expression)
    if (!ts.isIdentifier(node) || node.text !== rootName || direct.has(symbolOf(node))) return false
    const declaration = symbolOf(node)?.valueDeclaration
    return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
  }
  /** Nothing about `styles[k]` is to be said when `styles` was made here from something else. */
  const readOrQuiet = (expression, origins, key, at) => {
    if (key !== null || !isLocalOfTheRootName(expression)) read(origins, key, at)
  }
  const isCallee = (node) => {
    let here = node
    while (isWrapper(here.parent)) here = here.parent
    return ts.isCallExpression(here.parent) && here.parent.expression === here
  }

  const settle = (node) => {
    if (ts.isElementAccessExpression(node)) {
      const origins = originsOf(node.expression)
      if (origins.length > 0) {
        const keys = staticKeys(node.argumentExpression, checker)
        if (through(origins, keys).length === 0) for (const key of keys) readOrQuiet(node.expression, origins, key, node)
      }
      const unwrappedObject = unwrapped(node.expression)
      const held = ts.isIdentifier(unwrappedObject) ? objects.get(symbolOf(unwrappedObject)) : undefined
      if (held !== undefined && staticKeys(node.argumentExpression, checker).includes(null)) escaped([...held], node, 'read by a key this cannot read')
    } else if (ts.isPropertyAccessExpression(node)) {
      const origins = originsOf(node.expression)
      /* `.then(...)` on an `import()` waits for the module: no class is ever called. */
      const waits = PROMISE_METHODS.has(node.name.text) && isCallee(node)
      if (origins.length > 0 && !waits && !(node.name.text === rootName) && through(origins, [node.name.text]).length === 0) read(origins, node.name.text, node)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      const origins = originsOf(node.right)
      if (origins.length > 0) for (const key of staticKeys(node.left, checker)) read(origins, key, node)
    } else if (ts.isForInStatement(node)) {
      const origins = originsOf(node.expression)
      if (origins.length > 0 && !isLocalOfTheRootName(node.expression)) enumerated(origins, node)
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(unwrapped(node.expression)) && node.arguments.length > 0) {
      const callee = unwrapped(node.expression)
      if (ts.isIdentifier(callee.expression) && ['Object', 'Reflect'].includes(callee.expression.text)) {
        const origins = originsOf(node.arguments[0])
        if (origins.length > 0 && ENUMERATES.has(callee.name.text) && !isLocalOfTheRootName(node.arguments[0])) enumerated(origins, node)
        if (origins.length > 0 && READS_KEY.has(callee.name.text) && node.arguments[1] !== undefined) {
          for (const key of staticKeys(node.arguments[1], checker)) readOrQuiet(node.arguments[0], origins, key, node)
        }
      }
    }
    if (ts.isExportSpecifier(node) && node.parent.parent.moduleSpecifier === undefined) {
      const local = checker.getExportSpecifierLocalTargetSymbol(node)
      const held = [...(objects.get(local) ?? []), ...(elements.get(local) ?? [])]
      if (held.length > 0) escaped(held, node, 'exported in an array or object')
    }
    const isOccurrence = ts.isIdentifier(node) ? !isName(node) : ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
    if (isOccurrence && ts.isIdentifier(node)) {
      const symbol = symbolOf(node)
      const inside = [...(objects.get(symbol) ?? []), ...(elements.get(symbol) ?? [])]
      if (inside.length > 0) {
        const how = containerUse(node)
        if (how !== null) escaped(inside, node, how)
      }
      const made = returns.get(symbol)
      if (made !== undefined && made.size > 0 && !isCallee(node) && !ts.isExportAssignment(node.parent)) escaped([...made], node, 'a function that returns it, handed on')
    }
    if (isOccurrence) {
      const origins = originsOf(node)
      if (origins.length > 0 && !isLocalOfTheRootName(node)) {
        const how = useOf(node)
        if (how !== null) escaped(origins, node, how)
      }
    }
    ts.forEachChild(node, settle)
  }
  settle(source)

  return {
    originsOf,
    heldBy: (symbol) => [...(direct.get(symbol) ?? [])],
    returnsOf: (symbol) => [...(returns.get(symbol) ?? [])],
  }
}
