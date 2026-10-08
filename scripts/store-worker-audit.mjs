/**
 * AST-based Worker audit rules for DSH Store compliance.
 *
 * Implements Architecture Exception 1 & 2 (Phase 7A.5R4):
 * - Approves strictly ONE static companion worker:
 *     new Worker(new URL('./ecdict-integrity-worker.js', import.meta.url), approvedOptions)
 * - Forbids Worker with eval: true.
 * - Forbids data:, blob:, or remote network URLs.
 * - Forbids dynamic string concatenation or template interpolation in worker target.
 * - Forbids any other worker filenames.
 * - Forbids eval(), new Function(), dynamic import(), and child_process.
 * - Forbids companion worker from spawning nested workers or using forbidden capabilities.
 *
 * @module dsh-word-lookup/scripts/store-worker-audit
 */

import ts from 'typescript'

export const APPROVED_COMPANION_WORKER_REL = './ecdict-integrity-worker.js'

/**
 * Audits a Host production bundle (e.g. lib/index.js) via TypeScript AST.
 *
 * @param {string} sourceText - Emitted JavaScript content of host bundle.
 * @returns {{ approved: boolean, workerCount: number, errors: string[] }}
 */
export function auditHostWorkerUsage(sourceText) {
  const sourceFile = ts.createSourceFile('host-bundle.js', sourceText, ts.ScriptTarget.Latest, true)
  const errors = []
  let workerCount = 0

  function checkUrlArgument(argNode) {
    // Must be a NewExpression with identifier URL
    if (!ts.isNewExpression(argNode)) {
      if (ts.isStringLiteral(argNode)) {
        if (argNode.text.startsWith('data:')) return 'Worker target uses forbidden data: URL'
        if (argNode.text.startsWith('blob:')) return 'Worker target uses forbidden blob: URL'
        return 'Worker target is a raw string instead of static new URL(..., import.meta.url)'
      }
      return 'Worker target is not a new URL(...) expression'
    }

    if (!ts.isIdentifier(argNode.expression) || argNode.expression.text !== 'URL') {
      return 'Worker target is not a new URL(...) expression'
    }

    const urlArgs = argNode.arguments ?? []
    if (urlArgs.length < 2) {
      return 'new URL() must have at least 2 arguments (path, import.meta.url)'
    }

    const [pathArg, baseArg] = urlArgs

    // Check path argument: must be exact StringLiteral './ecdict-integrity-worker.js'
    if (ts.isBinaryExpression(pathArg) || ts.isTemplateExpression(pathArg)) {
      return 'Worker target uses dynamic string concatenation or template interpolation'
    }

    if (!ts.isStringLiteral(pathArg)) {
      return 'Worker target URL path must be a static string literal'
    }

    if (pathArg.text !== APPROVED_COMPANION_WORKER_REL) {
      return `Worker target "${pathArg.text}" is not the approved companion worker ("${APPROVED_COMPANION_WORKER_REL}")`
    }

    // Check base argument: must be import.meta.url
    const isImportMetaUrl =
      ts.isPropertyAccessExpression(baseArg) &&
      ts.isMetaProperty(baseArg.expression) &&
      baseArg.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      baseArg.name.text === 'url'

    if (!isImportMetaUrl) {
      return 'Worker target URL base must be import.meta.url'
    }

    return null
  }

  function checkWorkerOptions(optsNode) {
    if (!ts.isObjectLiteralExpression(optsNode)) {
      return null
    }

    for (const prop of optsNode.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = prop.name.getText(sourceFile).replace(/['"]/g, '')
        if (name === 'eval') {
          if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
            return 'Worker options specify forbidden eval: true'
          }
        }
      }
    }

    return null
  }

  function visit(node) {
    // 1. Check for eval()
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
      errors.push('Host bundle calls eval()')
    }

    // 2. Check for Function() or new Function()
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    ) {
      errors.push('Host bundle uses Function constructor')
    }

    // 3. Check for dynamic import()
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      errors.push('Host bundle uses dynamic import()')
    }

    // 4. Check for Worker instantiation
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Worker') {
      workerCount++
      const args = node.arguments ?? []
      if (args.length === 0) {
        errors.push('Worker called with no arguments')
      } else {
        const urlErr = checkUrlArgument(args[0])
        if (urlErr) {
          errors.push(urlErr)
        }
        if (args.length >= 2) {
          const optErr = checkWorkerOptions(args[1])
          if (optErr) {
            errors.push(optErr)
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  if (sourceText.includes('child_process')) {
    errors.push('Host bundle references child_process')
  }

  return {
    approved: errors.length === 0 && workerCount === 1,
    workerCount,
    errors,
  }
}

/**
 * Audits companion worker bundle (lib/ecdict-integrity-worker.js) for forbidden capabilities.
 *
 * @param {string} sourceText - Emitted JavaScript content of companion worker.
 * @returns {{ approved: boolean, errors: string[] }}
 */
export function auditCompanionWorker(sourceText) {
  const sourceFile = ts.createSourceFile('worker-bundle.js', sourceText, ts.ScriptTarget.Latest, true)
  const errors = []

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
      errors.push('Worker bundle calls eval()')
    }
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Function'
    ) {
      errors.push('Worker bundle uses Function constructor')
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      errors.push('Worker bundle uses dynamic import()')
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Worker') {
      errors.push('Companion worker attempts to spawn nested Worker')
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  if (sourceText.includes('child_process')) {
    errors.push('Worker bundle references child_process')
  }
  if (/process\s*\.\s*env/i.test(sourceText)) {
    errors.push('Worker bundle references process.env credentials')
  }

  return {
    approved: errors.length === 0,
    errors,
  }
}
