/**
 * Master Probe Runner: Phase 7A.8.0 Probes P01 - P20
 *
 * Executes all 20 probes across SQLite Safety, Event-Loop Stalls,
 * Activation Transaction Lifecycle, and Shortcuts Public API.
 * Aggregates runtime evidence into JSON and Markdown reports.
 *
 * @module scripts/probes/phase7a8-0/run-all-probes
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSqliteSafetyProbes } from './p01-p07-sqlite-safety.mjs'
import { runEventLoopAndWorkerProbes } from './p08-p09-event-loop-worker.mjs'
import { runActivationLifecycleProbes } from './p10-p13-activation-lifecycle.mjs'
import { runShortcutsProbes } from './p14-p20-shortcuts.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../../..')
const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence', 'phase7a8-0')

async function main() {
  console.log('======================================================================')
  console.log('  Executing Phase 7A.8.0 Capability Probes P01 - P20')
  console.log('======================================================================\n')

  mkdirSync(EVIDENCE_DIR, { recursive: true })

  console.log('-> Running Suite 1: P01 - P07 (SQLite Safety & File Contract)...')
  const s1 = await runSqliteSafetyProbes()
  console.log(`   Completed ${s1.length} probes.`)

  console.log('-> Running Suite 2: P08 - P09 (Event-Loop Blocking & Worker Feasibility)...')
  const s2 = await runEventLoopAndWorkerProbes()
  console.log(`   Completed ${s2.length} probes.`)

  console.log('-> Running Suite 3: P10 - P13 (Activation Lifecycle & Mutex Contract)...')
  const s3 = await runActivationLifecycleProbes()
  console.log(`   Completed ${s3.length} probes.`)

  console.log('-> Running Suite 4: P14 - P20 (DSH Shortcuts Service Capabilities)...')
  const s4 = await runShortcutsProbes()
  console.log(`   Completed ${s4.length} probes.`)

  const allProbes = [...s1, ...s2, ...s3, ...s4]

  const total = allProbes.length
  const passed = allProbes.filter((p) => p.status === 'PASS').length
  const failed = allProbes.filter((p) => p.status === 'FAIL').length

  console.log('\n======================================================================')
  console.log(`  Probe Execution Summary: Total: ${total} | PASS: ${passed} | FAIL: ${failed}`)
  console.log('======================================================================\n')

  // 1. Output JSON evidence
  const jsonPath = join(EVIDENCE_DIR, 'p01-p20-evidence.json')
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        summary: { total, passed, failed },
        probes: allProbes,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`[+] Wrote JSON evidence: ${jsonPath}`)

  // 2. Output Markdown Report
  let md = `# Phase 7A.8.0 Capability Probe & Transaction Contract Execution Report\n\n`
  md += `**Execution Timestamp**: \`${new Date().toISOString()}\`\n`
  md += `**Environment**: Node.js \`${process.version}\`, Windows 11 x64, DSH \`0.2.0-rc.2\`\n`
  md += `**Total Probes**: ${total} | **Passed**: ${passed} | **Failed**: ${failed}\n\n`
  md += `## Probe Matrix (P01 - P20)\n\n`
  md += `| Probe ID | Objective | Status | Evidence Level | Details Summary |\n`
  md += `| :--- | :--- | :---: | :---: | :--- |\n`

  for (const p of allProbes) {
    const summary = typeof p.details === 'object' ? Object.keys(p.details).map((k) => `${k}: ${JSON.stringify(p.details[k])}`).slice(0, 3).join('; ') : String(p.details)
    md += `| **${p.probeId}** | ${p.objective} | \`${p.status}\` | \`${p.evidenceType}\` | ${summary.replace(/\|/g, '\\|').slice(0, 100)}... |\n`
  }

  md += `\n## Detailed Empirical Findings\n\n`

  for (const p of allProbes) {
    md += `### ${p.probeId}: ${p.objective}\n\n`
    md += `- **Status**: \`${p.status}\`\n`
    md += `- **Evidence Classification**: \`${p.evidenceType}\`\n`
    md += `- **Limitation**: ${p.limitation}\n`
    md += `- **Raw Payload**:\n\`\`\`json\n${JSON.stringify(p.details, null, 2)}\n\`\`\`\n\n`
  }

  const mdPath = join(EVIDENCE_DIR, 'probe-execution-report.md')
  writeFileSync(mdPath, md, 'utf8')
  console.log(`[+] Wrote Markdown report: ${mdPath}\n`)

  if (failed > 0) {
    console.error(`[!] Execution ended with ${failed} failures!`)
    process.exitCode = 1
  } else {
    console.log('[*] All 20 capability probes PASSED successfully!')
  }
}

main().catch((err) => {
  console.error('Fatal probe execution error:', err)
  process.exit(1)
})
