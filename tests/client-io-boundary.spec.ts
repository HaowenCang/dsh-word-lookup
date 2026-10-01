/**
 * The I/O boundary of the browser half, asserted over the syntax tree.
 *
 * Phase 4 gives the client its first automatic path to the network, so "which
 * code can reach `fetch`" stops being obvious from reading the file. Two claims
 * have to survive every future edit, and neither can be checked by eye:
 *
 * ```text
 * selectionchange reaches no I/O        a selection change is never a trigger
 * one call site reaches the network     the transport, and nothing else
 * ```
 *
 * The assertions below parse the sources with the TypeScript compiler and reason
 * about the **call graph**, not about text. A grep would be defeated by
 * reformatting, by an alias, or by an import renamed at the boundary — and it
 * would also fire on the comments that discuss `fetch` precisely to say it is not
 * used. Working on the AST, the check is about reachability: what the handler can
 * actually call.
 *
 * @module dsh-word-lookup/tests/client-io-boundary
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/** Repository root, derived from this file's own location. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The browser half's sources. */
const CLIENT_DIR = join(ROOT, 'src', 'client')

/** The runtime that owns the listeners. */
const RUNTIME = join(CLIENT_DIR, 'index.tsx')

/** The one module allowed to reach the network. */
const TRANSPORT = join(CLIENT_DIR, 'transport.ts')

/**
 * Identifiers that would mean the reachable code performs I/O, decides a gesture
 * from a clock, or re-enters the trigger path.
 */
const FORBIDDEN_REACHABLE = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'requestLookup',
  'runLookup',
  'transport',
  'lookup',
  'captureSelection',
  'considerAutomatic',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
])

/** Parse one file. */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** Every source file in the browser half. */
function clientSources(): string[] {
  return readdirSync(CLIENT_DIR)
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
    .map((name) => join(CLIENT_DIR, name))
}

/**
 * Index every locally declared function by name.
 *
 * @param source - the parsed file.
 * @returns the name → body index.
 */
function localFunctions(source: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
        const init = declaration.initializer
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) functions.set(declaration.name.text, init.body)
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      functions.set(node.name.text, node.body)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return functions
}

/**
 * Every identifier reachable from a body, following locally declared functions.
 *
 * @param entry - the body to start from.
 * @param functions - the local function index.
 * @returns the reachable identifier names.
 */
function reachableIdentifiers(entry: ts.Node, functions: Map<string, ts.Node>): Set<string> {
  const seen = new Set<string>()
  const visiting = new Set<ts.Node>()
  const walk = (node: ts.Node): void => {
    if (visiting.has(node)) return
    visiting.add(node)
    if (ts.isIdentifier(node)) {
      seen.add(node.text)
      const body = functions.get(node.text)
      if (body !== undefined) walk(body)
    }
    ts.forEachChild(node, walk)
  }
  walk(entry)
  return seen
}

/**
 * Find every `addEventListener('<type>', handler)` call in a file.
 *
 * @param source - the parsed file.
 * @param type - the event type to look for.
 * @returns the handler expressions.
 */
function listenerHandlers(source: ts.SourceFile, type: string): ts.Expression[] {
  const handlers: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addEventListener' &&
      node.arguments.length >= 2
    ) {
      const [eventType, handler] = node.arguments
      if (eventType !== undefined && ts.isStringLiteralLike(eventType) && eventType.text === type && handler !== undefined) {
        handlers.push(handler)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return handlers
}

/**
 * Every call expression in a file whose callee ends in the given name.
 *
 * @param source - the parsed file.
 * @param name - the callee's final property or identifier name.
 * @returns the matching call expressions.
 */
function callsNamed(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const hits: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      if (ts.isIdentifier(callee) && callee.text === name) hits.push(node)
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === name) hits.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('selectionchange reaches no I/O', () => {
  const source = parse(RUNTIME)
  const functions = localFunctions(source)
  const handlers = listenerHandlers(source, 'selectionchange')

  it('registers the selection listener exactly once', () => {
    expect(handlers).toHaveLength(1)
  })

  it('resolves the handler to a local declaration, so its body is checkable', () => {
    const handler = handlers[0]
    expect(handler).toBeDefined()
    expect(ts.isIdentifier(handler as ts.Node)).toBe(true)
    const name = (handler as ts.Identifier).text
    expect(functions.has(name)).toBe(true)
  })

  it('reaches no identifier that could perform I/O or consult a clock', () => {
    const handler = handlers[0] as ts.Identifier
    const body = functions.get(handler.text)
    expect(body).toBeDefined()
    const reachable = reachableIdentifiers(body as ts.Node, functions)
    const violations = [...reachable].filter((name) => FORBIDDEN_REACHABLE.has(name))
    expect(violations).toEqual([])
  })

  it('cannot reach the trigger gate or the lookup path even transitively', () => {
    // Stated separately from the list above because these are the names Phase 4
    // introduced, and a reader changing the trigger path should see this fail
    // rather than have to work out which list it belonged to.
    const handler = handlers[0] as ts.Identifier
    const reachable = reachableIdentifiers(functions.get(handler.text) as ts.Node, functions)
    for (const name of ['captureSelection', 'considerAutomatic', 'runLookup', 'requestLookup']) {
      expect(reachable.has(name)).toBe(false)
    }
  })

  it('reads the selection and nothing else', () => {
    const handler = handlers[0] as ts.Identifier
    const reachable = reachableIdentifiers(functions.get(handler.text) as ts.Node, functions)
    expect(reachable.has('readEligibleSelection')).toBe(true)
    expect(reachable.has('selectionFacts')).toBe(true)
  })
})

describe('exactly one call site reaches the network', () => {
  it('contains a fetch call in the transport module only', () => {
    const withFetch = clientSources().filter((file) => callsNamed(parse(file), 'fetch').length > 0)
    expect(withFetch).toEqual([TRANSPORT])
  })

  it('calls the transport from the runtime exactly once, and wires it into the controller', () => {
    const source = parse(RUNTIME)
    const calls = callsNamed(source, 'requestLookup')
    expect(calls).toHaveLength(0)
    // The transport function is *referenced* once: it is handed to the controller
    // as a value, so the runtime never calls it directly and the boundary stays a
    // single line a reader can find.
    const references: number[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'requestLookup' && !ts.isImportSpecifier(node.parent)) {
        references.push(node.getStart(source))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(references).toHaveLength(1)
  })

  it('issues lookups from exactly the manual and the automatic call site', () => {
    const calls = callsNamed(parse(RUNTIME), 'runLookup')
    expect(calls).toHaveLength(2)
  })
})

describe('no timer decides a gesture', () => {
  it('uses no timer in the classifier, the gate or the runtime', () => {
    for (const module of ['gesture.ts', 'trigger.ts', 'lookup.ts', 'index.tsx']) {
      const source = parse(join(CLIENT_DIR, module))
      const timers = ['setTimeout', 'setInterval', 'setImmediate'].flatMap((name) => callsNamed(source, name))
      expect(timers, `${module} must not use a timer`).toEqual([])
    }
  })

  it('does not reference Date.now from the pure decision modules', () => {
    // The classifier and the gate receive the clock's value as an argument; they
    // never read it. That is what keeps their behaviour independent of timing.
    for (const module of ['gesture.ts', 'trigger.ts']) {
      const text = readFileSync(join(CLIENT_DIR, module), 'utf8')
      expect(text.includes('Date.now'), `${module} must not read the clock`).toBe(false)
    }
  })
})

describe('the pure decision modules stay free of I/O and the DOM', () => {
  it('references no network, DOM or storage global', () => {
    const forbidden = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|document|window|localStorage|sessionStorage|navigator)\b/
    for (const module of ['gesture.ts', 'trigger.ts', 'lookup.ts']) {
      const text = readFileSync(join(CLIENT_DIR, module), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
      const hit = forbidden.exec(text)
      expect(hit?.[0], `${module} must not reference ${String(hit?.[0])}`).toBeUndefined()
    }
  })

  it('keeps the classifier’s exported surface free of any I/O verb', () => {
    // The Phase 2 assertion, restated as an AST fact rather than a name scan: no
    // top-level declaration in the classifier mentions a request.
    const source = parse(join(CLIENT_DIR, 'gesture.ts'))
    const names: string[] = []
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) names.push(statement.name.text)
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text)
        }
      }
    }
    expect(names.filter((name) => /request|fetch|lookup|transport|send|post|abort/i.test(name))).toEqual([])
  })
})
