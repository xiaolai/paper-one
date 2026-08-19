import { featureItemNames, readCargoManifest, splitComment } from './cargo.mjs'
import { parseCompositionImports, stripComments } from './compositions.mjs'

/**
 * The edits `pnpm capability:remove <id>` makes, as pure functions over text:
 * each takes a file's content and returns `{ text, changed, … }` or throws
 * `RemovalRefused` when it cannot make the edit safely. Nothing here touches
 * a filesystem; `scripts/capability-remove.mjs` computes every edit through
 * these first and writes only when all of them succeeded — which is what
 * makes the operation all-or-nothing.
 *
 * The edits are SURGICAL. A file is cut, not regenerated: the manifest and
 * the ACL keep their formatting (a JSON element is removed by span, not by
 * `JSON.stringify`), Cargo.toml keeps its comments and array layout, and
 * lib.rs keeps rustfmt-clean shape for the registration forms this module
 * understands. A shape it does not understand is a refusal with the reason,
 * never a guess — an unrecognised `.plugin(…)` layout, a residual reference
 * to the removed name, another manifest entry that `requires` this one.
 *
 * Every removal that deletes a line also deletes the contiguous comment
 * lines directly above it (no blank line between): a comment sitting on a
 * dependency, a feature item or a chained `.plugin()` call is about that
 * line, and leaving it would make the file describe something it no longer
 * contains.
 */

export class RemovalRefused extends Error {
  constructor(message) {
    super(message)
    this.name = 'RemovalRefused'
  }
}

/* -------------------------------------------------------------- utilities */

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Lines `[from, to]` (inclusive) taken out; ranges may overlap. */
function deleteLineRanges(lines, ranges) {
  const drop = new Set()
  for (const [from, to] of ranges) for (let n = from; n <= to; n++) drop.add(n)
  return lines.filter((_, n) => !drop.has(n))
}

/** The first line of the run of `marker` comment lines ending just above
 *  `index`; `index` itself when there is none. */
function commentRunAbove(lines, index, isComment) {
  let first = index
  while (first > 0 && isComment(lines[first - 1])) first--
  return first
}

/** Two blank lines in a row become one, wherever a deletion left them. */
function collapseBlankRuns(lines) {
  const out = []
  for (const line of lines) {
    if (line.trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') continue
    out.push(line)
  }
  return out
}

/* --------------------------------------------------------- composition.ts */

/**
 * Take one capability out of a composition source: the `import` of
 * `../capabilities/<dir>` (any of its forms) and every element of the
 * `export const capabilities … = [ … ]` array literal that names what that
 * import bound. Returns `{ text, changed, names }`.
 *
 * Refuses when the import is not a plain static `import … from` statement,
 * when the array literal cannot be found or contains comments, or when a
 * bound name is still used in code after the edit — the capability is then
 * wired into this composition in a way this tool does not understand.
 */
export function removeFromComposition(source, dir) {
  const { imports } = parseCompositionImports(source)
  const found = imports.filter((item) => item.dir === dir && !item.deep)
  if (found.length === 0) return { text: source, changed: false, names: [] }

  let text = source
  const names = []
  for (const item of found) {
    const statement = new RegExp(
      `^[ \\t]*import\\s+([^;'"]+?)\\s+from\\s*['"]${escapeRegExp(item.specifier)}['"][ \\t]*;?[ \\t]*(?:\\r?\\n|$)`,
      'm',
    )
    const m = statement.exec(text)
    if (!m) throw new RemovalRefused(`composition imports ${JSON.stringify(item.specifier)} in a form other than \`import … from\`; edit it by hand`)
    names.push(...importedNames(m[1]))
    text = text.slice(0, m.index) + text.slice(m.index + m[0].length)
  }

  const array = findCapabilitiesArray(text)
  if (array === null) throw new RemovalRefused('composition has no `export const capabilities … = [ … ]` array literal')
  const inner = text.slice(array.open + 1, array.close)
  if (/\/\/|\/\*/.test(inner)) throw new RemovalRefused('the capabilities array literal contains a comment; edit it by hand')
  const elements = inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const kept = elements.filter((e) => !names.includes(e))
  const multiline = inner.includes('\n')
  let rebuilt
  if (kept.length === 0) rebuilt = ''
  else if (multiline) {
    const indent = /^\n?([ \t]*)/.exec(inner)?.[1] ?? '  '
    rebuilt = `\n${kept.map((e) => `${indent}${e},`).join('\n')}\n`
  } else rebuilt = kept.join(', ')
  text = text.slice(0, array.open + 1) + rebuilt + text.slice(array.close)

  /* String literals masked line-bounded (see `maskStrings`' rationale):
   * a UI label MENTIONING a capability's name must not refuse its removal. */
  /* Plain strings only: a TEMPLATE literal may interpolate the binding,
   * which is an executable reference masking would hide — templates stay
   * visible, at the cost of refusing on template prose. */
  const code = stripComments(text)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  for (const name of names) {
    /* Identifier-aware boundaries: `\b` sits between word and non-word, so
     * a name starting `$` matched nothing and a residual `$cap` survived. */
    if (new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(code)) {
      throw new RemovalRefused(`composition still references ${JSON.stringify(name)} after removing its import and array element; edit it by hand`)
    }
  }
  return { text, changed: true, names }
}

/** The local names an import clause binds: default, namespace, named (with
 *  `as`), `type`-qualified ones included. */
function importedNames(clause) {
  const names = []
  let rest = clause.trim()
  if (rest.startsWith('type ')) rest = rest.slice(5).trim()
  const braces = /\{([\s\S]*)\}/.exec(rest)
  if (braces) {
    for (const part of braces[1].split(',')) {
      const p = part.trim().replace(/^type\s+/, '')
      if (p === '') continue
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(p)
      names.push(as ? as[1] : p)
    }
    rest = (rest.slice(0, braces.index) + rest.slice(braces.index + braces[0].length)).trim()
  }
  for (const part of rest.split(',')) {
    const p = part.trim()
    if (p === '') continue
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p)
    names.push(ns ? ns[1] : p)
  }
  return names
}

/** `{ open, close }`: indices of the `[` and `]` of the capabilities array. */
function findCapabilitiesArray(text) {
  const head = /\bexport\s+const\s+capabilities\b[^=]*=\s*\[/.exec(text)
  if (!head) return null
  const open = head.index + head[0].length - 1
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '[') depth++
    else if (c === ']') {
      depth--
      if (depth === 0) return { open, close: i }
    }
  }
  return null
}

/* ------------------------------------------------------------------- JSON */

/**
 * The spans of the top-level elements of the array that is the value of
 * `key` at depth `depth` in a JSON text — the manifest's `capabilities`, an
 * ACL file's `permissions`. `{ open, close, elements: [{ start, end }] }`
 * (end exclusive), or null when the key is not there.
 */
export function findJsonArray(text, key, depth = 1) {
  let level = 0
  let inString = false
  let stringStart = -1
  let lastString = null // { value, end } of the most recent string at this level
  let expectingValueFor = null
  let i = 0
  const readString = (from) => {
    let j = from + 1
    while (j < text.length) {
      if (text[j] === '\\') j += 2
      else if (text[j] === '"') return j + 1
      else j++
    }
    throw new Error('unterminated string in JSON text')
  }
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      i = readString(stringStart)
      inString = false
      lastString = { value: JSON.parse(text.slice(stringStart, i)), end: i }
      continue
    }
    if (c === '"') {
      inString = true
      stringStart = i
      continue
    }
    if (c === ':' && level === depth && lastString !== null) {
      expectingValueFor = lastString.value
      lastString = null
      i++
      continue
    }
    if (c === '[' && level === depth && expectingValueFor === key) {
      const elements = []
      let j = i + 1
      let d = 0
      let start = -1
      for (; j < text.length; j++) {
        const ch = text[j]
        if (ch === '"') {
          if (start === -1) start = j
          j = readString(j) - 1
          continue
        }
        if (/\s/.test(ch)) continue
        if (ch === ',' && d === 0) {
          elements.push({ start, end: trimEnd(text, j) })
          start = -1
          continue
        }
        if (ch === ']' && d === 0) {
          if (start !== -1) elements.push({ start, end: trimEnd(text, j) })
          return { open: i, close: j, elements }
        }
        if (start === -1) start = j
        if (ch === '{' || ch === '[') d++
        else if (ch === '}' || ch === ']') d--
      }
      throw new Error('unterminated array in JSON text')
    }
    if (c === '{' || c === '[') {
      level++
      expectingValueFor = null
    } else if (c === '}' || c === ']') {
      level--
    } else if (c === ',') {
      expectingValueFor = null
    }
    i++
  }
  return null
}

/** The index just past the last non-whitespace character before `at`. */
function trimEnd(text, at) {
  let e = at
  while (e > 0 && /\s/.test(text[e - 1])) e--
  return e
}

/**
 * The text with the elements at `indices` removed from the array `array`
 * (as `findJsonArray` returned it), formatting around the survivors kept: a
 * middle element goes with the separator and whitespace up to the next one,
 * the last with the separator before it, the only one with everything
 * between the brackets.
 */
export function removeJsonElements(text, array, indices) {
  const drop = new Set(indices)
  if (drop.size === 0) return text
  const { elements, open, close } = array
  const survivors = [...elements.keys()].filter((i) => !drop.has(i))
  if (survivors.length === 0) return text.slice(0, open + 1) + text.slice(close)
  // Rebuilt from the survivors: the gap after `[`, each survivor followed by
  // the separator that followed it originally (whether or not its original
  // successor survives — the layout is the same either way), and the gap
  // that preceded `]`. Every byte kept is a byte of the original.
  let out = text.slice(0, open + 1) + text.slice(open + 1, elements[0].start)
  survivors.forEach((i, k) => {
    out += text.slice(elements[i].start, elements[i].end)
    if (k < survivors.length - 1) out += text.slice(elements[i].end, elements[i + 1].start)
  })
  return out + text.slice(elements[elements.length - 1].end, close) + text.slice(close)
}

/**
 * Take the manifest entry `id` out of the manifest text. Refuses when no
 * entry has that id, or when another entry lists it in `requires` (that
 * entry would then be broken; it is the caller's to fix first). Returns
 * `{ text, entry }`; the result is checked to parse back to the manifest
 * minus that entry.
 */
export function removeManifestEntry(text, id) {
  const manifest = JSON.parse(text)
  const entries = manifest.capabilities
  const index = entries.findIndex((entry) => entry.id === id)
  if (index === -1) throw new RemovalRefused(`no capability ${JSON.stringify(id)} in capabilities.manifest.json`)
  const dependents = entries.filter((entry) => Array.isArray(entry.requires) && entry.requires.includes(id)).map((entry) => entry.id)
  if (dependents.length > 0) {
    throw new RemovalRefused(`${dependents.map((d) => JSON.stringify(d)).join(', ')} require ${JSON.stringify(id)}; remove or edit them first`)
  }
  const array = findJsonArray(text, 'capabilities')
  if (array === null || array.elements.length !== entries.length) throw new RemovalRefused('cannot locate the capabilities array in the manifest text')
  const out = removeJsonElements(text, array, [index])
  const expected = { ...manifest, capabilities: entries.filter((_, i) => i !== index) }
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(expected)) throw new RemovalRefused('manifest edit did not produce the expected document; refusing to write')
  return { text: out, entry: entries[index], changed: true }
}

/**
 * Take the ACL grants a `predicate` selects out of an ACL capability file,
 * whether each is written as a bare string or an object with `identifier`.
 * `{ text, changed, removed }`.
 */
function removeAclWhere(text, predicate) {
  const json = JSON.parse(text)
  if (!Array.isArray(json.permissions)) return { text, changed: false, removed: [] }
  const array = findJsonArray(text, 'permissions')
  if (array === null || array.elements.length !== json.permissions.length) throw new RemovalRefused('cannot locate the permissions array in the ACL text')
  const identifierOf = (item) => (typeof item === 'string' ? item : item && typeof item.identifier === 'string' ? item.identifier : null)
  const indices = []
  const removed = []
  json.permissions.forEach((item, i) => {
    const identifier = identifierOf(item)
    if (identifier !== null && predicate(identifier)) {
      indices.push(i)
      removed.push(identifier)
    }
  })
  if (indices.length === 0) return { text, changed: false, removed }
  const out = removeJsonElements(text, array, indices)
  const expected = { ...json, permissions: json.permissions.filter((_, i) => !indices.includes(i)) }
  if (JSON.stringify(JSON.parse(out)) !== JSON.stringify(expected)) throw new RemovalRefused('ACL edit did not produce the expected document; refusing to write')
  return { text: out, changed: true, removed }
}

/**
 * Take every grant under `namespace:` (`peer:default`, `peer:allow-status`)
 * out of an ACL capability file. `{ text, changed, removed }`.
 */
export function removeAclGrants(text, namespace) {
  const prefix = `${namespace}:`
  return removeAclWhere(text, (identifier) => identifier.startsWith(prefix))
}

/**
 * Take the EXACT grant identifiers `wanted` out of an ACL capability file —
 * for removal driven by a manifest's declared `permissions`, where the ACL
 * namespace (`peer`) is not the crate name (`tauri-plugin-peer`) and a prefix
 * guessed from the crate would miss the grant entirely.
 * `{ text, changed, removed }`.
 */
export function removeAclIdentifiers(text, wanted) {
  const set = new Set(wanted)
  return removeAclWhere(text, (identifier) => set.has(identifier))
}

/* ------------------------------------------------------------- Cargo.toml */

/**
 * Take the dependency `depName` out of the app's Cargo.toml: its
 * `[dependencies]` line or `[dependencies.<name>]` table (with the comment
 * run above it), and every `[features]` item that names it (`dep:x`, `x/f`,
 * `x?/f`, bare optional `x`), each array's layout otherwise kept.
 * `{ text, changed, removedFeatureItems }`.
 */
export function removeCargoDependency(text, depName) {
  const manifest = readCargoManifest(text)
  const dep = manifest.dependencies.get(depName)
  if (!dep) return { text, changed: false, removedFeatureItems: [] }
  const isComment = (line) => /^\s*#/.test(line)
  let lines = text.split('\n')

  const edits = [] // { from, to, replacement: string[] } over original line numbers
  const [first, last] = dep.lines
  edits.push({ from: commentRunAbove(lines, first, isComment), to: last, replacement: [] })

  const removedFeatureItems = []
  for (const feature of manifest.features.values()) {
    const gone = feature.items.filter((item) => featureItemNames(item, depName, manifest))
    if (gone.length === 0) continue
    removedFeatureItems.push(...gone.map((item) => `${feature.name}: ${item}`))
    const goneSet = new Set(gone)
    const [f, l] = feature.lines
    const replacement = []
    for (let n = f; n <= l; n++) {
      const rewritten = rewriteFeatureLine(lines[n], goneSet)
      if (rewritten !== null) replacement.push(rewritten)
    }
    edits.push({ from: f, to: l, replacement })
  }

  edits.sort((a, b) => b.from - a.from)
  for (const edit of edits) lines.splice(edit.from, edit.to - edit.from + 1, ...edit.replacement)
  lines = collapseBlankRuns(lines)
  return { text: lines.join('\n'), changed: true, removedFeatureItems }
}

/**
 * One line of a feature array with the items in `gone` taken out. Null when
 * nothing but those items (and their commas) was on the line.
 */
function rewriteFeatureLine(line, gone) {
  const [code, comment] = splitComment(line)
  /* Items live to the RIGHT of the assignment: a quoted feature key
   * (`"my-feature" = [...]`) is syntax, and tokenizing it as an item once
   * deleted the key and left invalid TOML. */
  const eq = assignmentEq(code)
  const value = eq === -1 ? code : code.slice(eq)
  const offset = eq === -1 ? 0 : eq
  const tokens = [...value.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)].map((t) => {
    t.index += offset
    return t
  })
  if (tokens.length === 0) return line
  const values = tokens.map((t) => (t[0].startsWith('"') ? JSON.parse(t[0]) : t[0].slice(1, -1)))
  if (!values.some((v) => gone.has(v))) return line
  const kept = tokens.filter((_, i) => !gone.has(values[i])).map((t) => t[0])
  const prefix = code.slice(0, tokens[0].index)
  let suffix = code.slice(tokens[tokens.length - 1].index + tokens[tokens.length - 1][0].length)
  if (kept.length === 0) {
    // Nothing but the removed items was on this line: it goes, and a
    // trailing comment goes with it — it was about them. A bracket or other
    // code after them stays.
    suffix = suffix.replace(/^\s*,\s*/, '')
    /* Deleted only when NOTHING structural was on it: a prefix like `f = [`
     * is the assignment's opening syntax, and deleting its line leaves
     * invalid TOML behind. */
    if (suffix.trim() === '' && prefix.trim() === '') return null
    return `${prefix}${suffix}${comment}`.replace(/\s+$/, '')
  }
  return `${prefix}${kept.join(', ')}${suffix}${comment}`.replace(/\s+$/, '')
}

/* ----------------------------------------------------------------- lib.rs */

/**
 * Take `.plugin(<name>::init())` out of `lib.rs`, in the shapes rustfmt
 * writes:
 *
 *   (A) the call on a line of its own in a builder chain — the line goes,
 *       with the comment run above it; a trailing `;` moves up to the
 *       previous line;
 *   (B) the call inline in a longer statement — the call text goes;
 *   (S) either of those leaving `x = x;` — that statement goes too, and a
 *       bare `{ … }` block it leaves empty goes with its `#[cfg(…)]`
 *       attributes and comment run.
 *
 * Anything else — a multi-line call, a block with a condition left empty, a
 * remaining code reference to the crate (`use`, another call) — is refused.
 * `{ text, changed }`.
 */
export function removePluginRegistration(source, name) {
  const call = new RegExp(`\\.plugin\\(\\s*${escapeRegExp(name)}::init\\(\\)\\s*\\)`)
  const isComment = (line) => /^\s*\/\//.test(line)
  const isAttribute = (line) => /^\s*#\[/.test(line)
  let lines = source.split('\n')
  let changed = false

  for (;;) {
    const at = lines.findIndex((line) => call.test(maskStrings(splitRustComment(line))))
    if (at === -1) break
    changed = true
    const line = lines[at]
    /* Judged comment-free AND string-masked: a trailing note must not hide
     * the own-line shape, and a log line QUOTING the call must not be
     * edited as if it were the call — masked, it never matches, and the
     * residual-reference refusal below answers for it instead. */
    const own = new RegExp(`^(\\s*)${call.source}\\s*(;?)\\s*$`).exec(maskStrings(splitRustComment(line)))
    let statementGone = -1 // index of a whole statement removed (case S)
    if (own) {
      const from = commentRunAbove(lines, at, isComment)
      const semicolon = own[2] === ';'
      lines = deleteLineRanges(lines, [[from, at]])
      let prev = from - 1
      if (semicolon) {
        if (prev < 0) throw new RemovalRefused('lib.rs: a chained .plugin() call with nothing before it')
        /* Code and trailing comment are judged — and edited — apart: the
         * comment hid `builder = builder` from the self-assignment check,
         * and appending `;` after it put the semicolon inside the comment. */
        const code = splitRustComment(lines[prev])
        const comment = lines[prev].slice(code.length).trim()
        if (isSelfAssignment(`${code.trimEnd()};`)) statementGone = prev
        else lines[prev] = comment === '' ? `${lines[prev]};` : `${code.trimEnd()}; ${comment}`
      }
    } else {
      /* Spliced by the MASKED match's indexes: a raw `replace` would hit a
       * quoted decoy earlier on the same line and edit prose instead of the
       * call. The mask is length-preserving, so the indexes line up. */
      const found = call.exec(maskStrings(splitRustComment(line)))
      const rewritten =
        found === null ? line.replace(call, '') : line.slice(0, found.index) + line.slice(found.index + found[0].length)
      if (isSelfAssignment(splitRustComment(rewritten))) statementGone = at
      else lines[at] = rewritten
    }
    if (statementGone !== -1) {
      const from = commentRunAbove(lines, statementGone, isComment)
      lines = deleteLineRanges(lines, [[from, statementGone]])
      // An enclosing block left with nothing in it.
      let open = from - 1
      while (open >= 0 && lines[open].trim() === '') open--
      let close = from
      while (close < lines.length && lines[close].trim() === '') close++
      if (open >= 0 && close < lines.length && /^\s*\}\s*$/.test(lines[close]) && /\{\s*$/.test(lines[open])) {
        if (!/^\s*\{\s*$/.test(lines[open])) {
          throw new RemovalRefused(`lib.rs: removing the registration leaves the block opened by ${JSON.stringify(lines[open].trim())} empty; edit it by hand`)
        }
        let start = open
        while (start > 0 && (isAttribute(lines[start - 1]) || isComment(lines[start - 1]))) start--
        lines = deleteLineRanges(lines, [[start, close]])
      }
    }
    lines = collapseBlankRuns(lines)
  }
  if (!changed) {
    /* No single-line registration matched — but the crate may still be
     * referenced in a shape this tool cannot edit (a multi-line
     * `.plugin(...)`, a `use`). Returning `changed: false` here once let a
     * caller prune the crate while its registration stayed live; a
     * reference it cannot remove is a refusal. String literals are masked
     * first — a log line MENTIONING the crate is prose, not a reference. */
    if (new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(maskStrings(stripComments(source)))) {
      throw new RemovalRefused(`lib.rs references ${name} in a shape this tool cannot edit (a multi-line .plugin(...) call, a use, or another call); edit it by hand`)
    }
    return { text: source, changed: false }
  }
  const text = lines.join('\n')
  if (new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(maskStrings(stripComments(text)))) {
    throw new RemovalRefused(`lib.rs still references ${name} after removing its .plugin() registration (a \`use\`, or another call); edit it by hand`)
  }
  return { text, changed: true }
}

/** `x = x;` — what a builder statement becomes when its only call goes.
 *  Callers hand this COMMENT-FREE text (`splitRustComment`), or a trailing
 *  comment would hide the very statement this exists to catch. */
function isSelfAssignment(line) {
  const m = /^\s*([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\s*;\s*$/.exec(line)
  return m !== null && m[1] === m[2]
}

/** The index of the first `=` OUTSIDE any quoted string — a quoted TOML key
 *  may itself contain one (`"a=b" = [...]`). -1 when the line assigns
 *  nothing. */
function assignmentEq(code) {
  let quote = null
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (quote !== null) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '=') return i
  }
  return -1
}

/** Line-bounded string literals blanked, so a name inside prose cannot pass
 *  for a code reference. Bounded per line on purpose: an unpaired quote (a
 *  char literal, an apostrophe) must not swallow the lines after it. */
function maskStrings(text) {
  /* LENGTH-PRESERVING: callers match against the masked text and edit the
   * RAW text by the match's indexes, so every character must stay put. */
  return text.replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${' '.repeat(m.length - 2)}"`)
}

/** A Rust line without its `//` comment (strings respected). */
function splitRustComment(line) {
  let quote = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === '"') quote = false
      continue
    }
    if (c === '"') quote = true
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
    else if (c === '/' && line[i + 1] === '*') {
      /* A trailing single-line block comment hides code state the same way
       * `//` does; one that does not close on this line is treated the
       * same — the caller judges the code before it. */
      return line.slice(0, i)
    }
  }
  return line
}
