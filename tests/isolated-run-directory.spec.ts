import { afterEach, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createOwnedTestRoot, cleanupOwnedTestRoot, reopenOwnedTestRoot, createOwnedHome, cleanupOwnedHome } from '../scripts/isolated-run-directory.mjs'
import { createReleaseTestRoot, cleanupReleaseTestRoot } from '../scripts/probes/release-v0.2.1/release-smoke.mjs'

const fixtures: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'owned-regression-'))
  fixtures.push(root)
  const production = join(root, 'production')
  mkdirSync(production)
  writeFileSync(join(production, 'sentinel'), 'safe')
  return { root, production, env: { DSH_HOME: production }, requestedRoot: join(root, 'run') }
}
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('owned test root', () => {
  it('refuses a production alias below the owned root during cleanup', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    symlinkSync(f.production, join(owner.path, 'alias'), 'junction')
    await expect(cleanupOwnedTestRoot(owner)).rejects.toThrow(/production/)
    expect(readFileSync(join(f.production, 'sentinel'), 'utf8')).toBe('safe')
  })
  it('creates exclusively and only removes its root, preserving outside evidence', async () => {
    const f = fixture()
    const owner = await createOwnedTestRoot(f)
    writeFileSync(join(owner.path, 'data'), 'scratch')
    await cleanupOwnedTestRoot(owner)
    expect(existsSync(owner.path)).toBe(false)
    expect(readFileSync(join(f.production, 'sentinel'), 'utf8')).toBe('safe')
  })

  it('refuses an arbitrary existing directory without adding a marker', async () => {
    const f = fixture(); mkdirSync(f.requestedRoot)
    await expect(createOwnedTestRoot(f)).rejects.toThrow(/exist/i)
    expect(existsSync(join(f.requestedRoot, '.dsh-test-owner.json'))).toBe(false)
  })

  it('refuses an ancestor of production before any creation or deletion', async () => {
    const f = fixture()
    await expect(createOwnedTestRoot({ ...f, requestedRoot: f.root })).rejects.toThrow(/production/)
    expect(readFileSync(join(f.production, 'sentinel'), 'utf8')).toBe('safe')
    expect(existsSync(join(f.root, '.dsh-test-owner.json'))).toBe(false)
  })

  it.each(['missing', 'forged', 'replaced'])('refuses a %s marker', async (mode) => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    const marker = join(owner.path, '.dsh-test-owner.json')
    if (mode === 'missing') rmSync(marker)
    if (mode === 'forged') writeFileSync(marker, '{}')
    if (mode === 'replaced') { const content = readFileSync(marker); renameSync(marker, `${marker}.old`); writeFileSync(marker, content) }
    await expect(cleanupOwnedTestRoot(owner)).rejects.toThrow(/ownership|marker/i)
    expect(existsSync(owner.path)).toBe(true)
  })

  it('refuses a replaced directory even with copied marker content', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    const content = readFileSync(join(owner.path, '.dsh-test-owner.json'))
    renameSync(owner.path, `${owner.path}.old`); mkdirSync(owner.path)
    writeFileSync(join(owner.path, '.dsh-test-owner.json'), content)
    await expect(cleanupOwnedTestRoot(owner)).rejects.toThrow(/identity|ownership/i)
    expect(existsSync(owner.path)).toBe(true)
  })

  it('refuses unknown ownership and a serialized copy of a capability', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    // @ts-expect-error A plain object deliberately lacks the opaque runtime capability.
    await expect(cleanupOwnedTestRoot({ path: owner.path })).rejects.toThrow(/ownership/i)
    await expect(cleanupOwnedTestRoot(JSON.parse(JSON.stringify(owner)))).rejects.toThrow(/ownership/i)
  })

  it('requires a separately supplied secret to reopen and checks the actual home identity', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    const home = join(owner.path, 'home')
    await createOwnedHome(owner, home)
    await expect(reopenOwnedTestRoot({ ...f, token: 'wrong' })).rejects.toThrow(/token|ownership/i)
    const reopened = await reopenOwnedTestRoot({ ...f, token: owner.cleanupToken })
    renameSync(home, `${home}.old`); mkdirSync(home)
    await expect(cleanupOwnedHome(reopened, home)).rejects.toThrow(/identity|ownership/i)
    expect(existsSync(home)).toBe(true)
  })

  it('allows an owned home cleanup and leaves the ownership root available', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    const home = join(owner.path, 'home'); await createOwnedHome(owner, home)
    await cleanupOwnedHome(owner, home)
    expect(existsSync(home)).toBe(false)
    expect(existsSync(owner.path)).toBe(true)
  })

  it('refuses root replacement with a production junction', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    renameSync(owner.path, `${owner.path}.old`)
    symlinkSync(f.production, owner.path, 'junction')
    await expect(cleanupOwnedTestRoot(owner)).rejects.toThrow(/production|link|identity/)
    expect(readFileSync(join(f.production, 'sentinel'), 'utf8')).toBe('safe')
  })
})

const repo = fileURLToPath(new URL('..', import.meta.url))
function cli(script: string, args: string[], production: string) {
  const sandbox = mkdtempSync(join(tmpdir(), 'owned-cli-user-')); fixtures.push(sandbox)
  const home = join(sandbox, 'user'); const temporary = join(sandbox, 'tmp')
  mkdirSync(home); mkdirSync(temporary)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_/i.test(key)))
  const isolatedEnv = { ...env, HOME: home, USERPROFILE: home, TMP: temporary, TEMP: temporary, DSH_HOME: production }
  const preflight = spawnSync(process.execPath, ['--input-type=module', '-e', 'import os from "node:os"; import path from "node:path"; if(path.resolve(os.homedir()) !== path.resolve(process.env.USERPROFILE) || path.resolve(os.tmpdir()) !== path.resolve(process.env.TEMP)) process.exit(2)'], { env: isolatedEnv, encoding: 'utf8' })
  expect(preflight.status, preflight.stderr).toBe(0)
  return spawnSync(process.execPath, [resolve(repo, 'scripts', script), ...args], { cwd: repo, env: isolatedEnv, encoding: 'utf8', timeout: 10000 })
}

describe('profile create/cleanup CLI', () => {
  it('forwards the owned test root to the measurement child without starting DSH', () => {
    const f = fixture()
    const sandbox = join(f.root, 'stub-repo'); mkdirSync(join(sandbox, 'scripts'), { recursive: true })
    for (const name of ['run-integration-test.mjs', 'assert-isolated-env.mjs']) copyFileSync(join(repo, 'scripts', name), join(sandbox, 'scripts', name))
    writeFileSync(join(sandbox, 'scripts', 'phase1-verify.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))')
    const home = join(f.requestedRoot, 'home')
    mkdirSync(join(home, 'profiles', 'word-lookup-test'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'word-lookup-test', 'package.json'), '{}')
    const result = cli(join(sandbox, 'scripts', 'run-integration-test.mjs'), ['--test-root', f.requestedRoot], f.production)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('"--test-root"')
    expect(result.stdout).toContain(JSON.stringify(f.requestedRoot))
  })
  function create(f: ReturnType<typeof fixture>) {
    const plugin = join(f.root, 'plugin'); mkdirSync(join(plugin, 'lib'), { recursive: true })
    writeFileSync(join(plugin, 'lib', 'client.js'), ''); writeFileSync(join(plugin, 'lib', 'index.js'), '')
    const result = cli('create-test-profile.mjs', ['--test-root', f.requestedRoot, '--plugin', plugin, '--skip-dsh-version'], f.production)
    expect(result.status, result.stderr).toBe(0)
    const token = /CLEANUP_TOKEN=([a-f0-9]{64})/.exec(result.stdout)?.[1]
    expect(token).toBeTruthy()
    return token!
  }
  it('creates and removes only the independently authorized root and actual home', () => {
    const f = fixture(); const token = create(f)
    const result = cli('cleanup-test-profile.mjs', ['--test-root', f.requestedRoot, '--cleanup-token', token, '--evidence-recorded', '--processes-exited'], f.production)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(f.requestedRoot)).toBe(false)
    expect(readFileSync(join(f.production, 'sentinel'), 'utf8')).toBe('safe')
  })
  it('rejects an arbitrary existing root before any profile writes', () => {
    const f = fixture(); mkdirSync(f.requestedRoot)
    const plugin = join(f.root, 'plugin'); mkdirSync(join(plugin, 'lib'), { recursive: true })
    writeFileSync(join(plugin, 'lib', 'client.js'), ''); writeFileSync(join(plugin, 'lib', 'index.js'), '')
    const result = cli('create-test-profile.mjs', ['--test-root', f.requestedRoot, '--plugin', plugin, '--skip-dsh-version'], f.production)
    expect(result.status).not.toBe(0)
    expect(existsSync(join(f.requestedRoot, 'home'))).toBe(false)
  })
  it.each(['missing-token', 'wrong-token', 'missing-process-confirmation', 'missing-evidence', 'replaced-home', 'home-production-junction'])('preserves user data on %s', (mode) => {
    const f = fixture(); const token = create(f)
    const home = join(f.requestedRoot, 'home')
    if (mode === 'replaced-home' || mode === 'home-production-junction') {
      renameSync(home, `${home}.original`)
      if (mode === 'replaced-home') mkdirSync(home)
      else symlinkSync(f.production, home, 'junction')
    }
    const args = ['--test-root', f.requestedRoot]
    if (mode !== 'missing-token') args.push('--cleanup-token', mode === 'wrong-token' ? 'a'.repeat(64) : token)
    if (mode !== 'missing-process-confirmation') args.push('--processes-exited')
    if (mode !== 'missing-evidence') args.push('--evidence-recorded')
    const result = cli('cleanup-test-profile.mjs', args, f.production)
    expect(result.status).not.toBe(0)
    expect(existsSync(home)).toBe(true)
    expect(readFileSync(join(f.production, 'sentinel'), 'utf8')).toBe('safe')
  })
})

describe('release cleanup', () => {
  it('refuses an actual release home that was never registered as owned', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    const home = join(owner.path, 'home'); mkdirSync(home)
    writeFileSync(join(home, 'sentinel'), 'unregistered-home')
    await expect(cleanupReleaseTestRoot(owner, {
      children: [{ exitCode: 0, signalCode: null }], ports: [], evidencePaths: [],
    })).rejects.toThrow(/home|ownership/i)
    expect(readFileSync(join(home, 'sentinel'), 'utf8')).toBe('unregistered-home')
  })
  it('registers the actual release home and refuses its replacement during cleanup', async () => {
    const f = fixture(); const owner = await createReleaseTestRoot(f)
    const home = join(owner.path, 'home')
    renameSync(home, `${home}.original`); mkdirSync(home)
    writeFileSync(join(home, 'sentinel'), 'replacement-home')
    await expect(cleanupReleaseTestRoot(owner, {
      children: [{ exitCode: 0, signalCode: null }], ports: [], evidencePaths: [],
    })).rejects.toThrow(/home|identity|ownership/i)
    expect(readFileSync(join(home, 'sentinel'), 'utf8')).toBe('replacement-home')
    expect(readFileSync(join(f.production, 'sentinel'), 'utf8')).toBe('safe')
  })
  it('retains the root when a child has no trustworthy exit status', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    // @ts-expect-error Missing fields are deliberately untrusted process observations.
    await expect(cleanupReleaseTestRoot(owner, { children: [{}], ports: [], evidencePaths: [] })).rejects.toThrow(/exit/)
    expect(existsSync(owner.path)).toBe(true)
  })
  it.each(['root-contains-production', 'evidence-in-root', 'evidence-production-junction', 'existing-root'])('refuses %s before any evidence or test write', (mode) => {
    const f = fixture()
    let testRoot = f.requestedRoot
    let evidence = join(f.root, 'evidence')
    if (mode === 'root-contains-production') testRoot = f.root
    if (mode === 'evidence-in-root') evidence = join(testRoot, 'evidence')
    if (mode === 'evidence-production-junction') { symlinkSync(f.production, join(f.root, 'alias'), 'junction'); evidence = join(f.root, 'alias', 'missing-evidence') }
    if (mode === 'existing-root') mkdirSync(testRoot)
    const result = cli('probes/release-v0.2.1/release-smoke.mjs', ['--source', 'local-tarball', '--test-root', testRoot, '--evidence-dir', evidence, '--dsh-bin', join(f.root, 'never-run.mjs')], f.production)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/production|overlaps|already exists/)
    expect(existsSync(evidence)).toBe(false)
    expect(existsSync(join(testRoot, 'home'))).toBe(false)
    expect(readFileSync(join(f.production, 'sentinel'), 'utf8')).toBe('safe')
  })
  it('retains the root while any owned child is unconfirmed', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    await expect(cleanupReleaseTestRoot(owner, { children: [{ exitCode: null, signalCode: null }], ports: [], evidencePaths: [] })).rejects.toThrow(/exit/)
    expect(existsSync(owner.path)).toBe(true)
  })
  it('retains the root while its port remains occupied', async () => {
    const f = fixture(); const owner = await createOwnedTestRoot(f)
    const server = createServer()
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const port = (server.address() as { port: number }).port
      await expect(cleanupReleaseTestRoot(owner, { children: [], ports: [port], evidencePaths: [] })).rejects.toThrow(/port/)
      expect(existsSync(owner.path)).toBe(true)
    } finally { await new Promise<void>((done, reject) => server.close(e => e ? reject(e) : done())) }
  })
  it('retains evidence inside the root and cleans only after evidence is outside', async () => {
    const f = fixture(); const owner = await createReleaseTestRoot(f)
    await expect(cleanupReleaseTestRoot(owner, { children: [], ports: [], evidencePaths: [join(owner.path, 'report.json')] })).rejects.toThrow(/evidence/)
    const report = join(f.root, 'report.json'); writeFileSync(report, '{}')
    await cleanupReleaseTestRoot(owner, { children: [{ exitCode: 0, signalCode: null }], ports: [], evidencePaths: [report] })
    expect(existsSync(owner.path)).toBe(false)
    expect(existsSync(report)).toBe(true)
  })
})
