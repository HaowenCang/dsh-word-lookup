/** Owned scratch directories. Importing this module performs no I/O. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { assertDisjointProductionPaths, isInsideOrEqual, normalisePath } from './assert-isolated-env.mjs'

const MARKER = '.dsh-test-owner.json'
const owners = new WeakMap()
const digest = (token) => createHash('sha256').update(token).digest('hex')
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const refuse = (detail) => new Error(`test directory ownership refused: ${detail}; directory retained`)

async function directoryIdentity(path) {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw refuse(`not an ordinary directory: ${path}`)
  return identity(stat)
}

function capability(state, token) {
  const owner = Object.freeze({ path: state.path, ...(token ? { cleanupToken: token } : {}) })
  owners.set(owner, state)
  return owner
}

async function saveMarker(state, exclusive = false) {
  const handle = await open(join(state.path, MARKER), exclusive ? 'wx' : 'r+')
  try {
    if (!exclusive && identity(await handle.stat({ bigint: true })) !== state.markerIdentity) throw refuse('marker identity changed')
    state.record.markerIdentity = identity(await handle.stat({ bigint: true }))
    await handle.truncate(0)
    await handle.writeFile(JSON.stringify(state.record), 'utf8')
    state.markerIdentity = identity(await handle.stat({ bigint: true }))
  } finally { await handle.close() }
}

/** Exact requested path must not exist. Parent must already be an ordinary directory. */
export async function createOwnedTestRoot({ requestedRoot, env = process.env } = {}) {
  const path = resolve(requestedRoot ?? join(tmpdir(), `dsh-owned-${randomUUID()}`))
  const factsEnv = { ...env }
  assertDisjointProductionPaths([path], factsEnv)
  // Resolve before creating; ENOENT is the only accepted missing-path condition.
  const canonical = normalisePath(path)
  const token = randomBytes(32).toString('hex')
  await mkdir(path) // exclusive; never acquire ownership of a preexisting directory
  const state = { path, env: factsEnv, canonical, rootIdentity: await directoryIdentity(path), markerIdentity: null }
  assertDisjointProductionPaths([path], factsEnv)
  if (normalisePath(path) !== canonical) throw refuse('canonical path changed during creation')
  state.record = { version: 1, path, canonical, rootIdentity: state.rootIdentity, nonce: randomUUID(), tokenHash: digest(token), home: null }
  await saveMarker(state, true)
  return capability(state, token)
}

async function verify(owner) {
  const state = owners.get(owner)
  if (!state) throw refuse('unknown runtime ownership')
  assertDisjointProductionPaths([state.path], state.env)
  if (normalisePath(state.path) !== state.canonical || await directoryIdentity(state.path) !== state.rootIdentity) throw refuse('root identity or canonical path changed')
  const markerPath = join(state.path, MARKER)
  let marker, stat
  try {
    stat = await lstat(markerPath, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== state.markerIdentity) throw refuse('marker identity changed')
    marker = JSON.parse(await readFile(markerPath, 'utf8'))
  } catch (error) { throw refuse(`marker cannot be verified: ${error.message}`) }
  if (JSON.stringify(marker) !== JSON.stringify(state.record)) throw refuse('marker nonce or ownership record changed')
  return state
}

/** Cross-process CLI compatibility: token is supplied separately, never read as authority from the marker. */
export async function reopenOwnedTestRoot({ requestedRoot, token, env = process.env }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw refuse('missing or invalid cleanup token')
  const path = resolve(requestedRoot)
  assertDisjointProductionPaths([path], env)
  const markerPath = join(path, MARKER)
  const markerStat = await lstat(markerPath, { bigint: true })
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw refuse('invalid marker')
  const record = JSON.parse(await readFile(markerPath, 'utf8'))
  if (record.version !== 1 || record.path !== path || record.markerIdentity !== identity(markerStat) || !same(record.tokenHash, digest(token))) throw refuse('cleanup token or ownership mismatch')
  const state = { path, env: { ...env }, canonical: record.canonical, rootIdentity: record.rootIdentity, markerIdentity: identity(markerStat), record }
  const owner = capability(state)
  await verify(owner)
  return owner
}

/** Exclusively create the actual home and bind its identity to the owner's record. */
export async function createOwnedHome(owner, home) {
  const state = await verify(owner)
  const path = resolve(home)
  assertDisjointProductionPaths([path], state.env)
  if (!isInsideOrEqual(path, state.path) || normalisePath(path) === state.canonical || dirname(path) !== state.path) throw refuse('home must be a direct child of the owned root')
  if (state.record.home) throw refuse('home is already owned')
  await mkdir(path)
  state.record.home = { path, canonical: normalisePath(path), identity: await directoryIdentity(path) }
  await saveMarker(state)
}

async function verifyHome(state, home) {
  const record = state.record.home
  const path = resolve(home)
  assertDisjointProductionPaths([path], state.env)
  if (!record || path !== record.path || !isInsideOrEqual(path, state.path) || normalisePath(path) !== record.canonical || await directoryIdentity(path) !== record.identity) throw refuse('home identity or ownership changed')
}

/** Inspect links without traversing them. Safe dependency junctions are unlinked by rm, never followed. */
async function checkTree(path, env) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    const stat = await lstat(child)
    assertDisjointProductionPaths([child], env)
    if (stat.isSymbolicLink()) {
      // Also fail closed on dangling links and resolution failures.
      await realpath(child)
    } else if (stat.isDirectory()) await checkTree(child, env)
  }
}

export async function cleanupOwnedHome(owner, home) {
  const state = await verify(owner)
  await verifyHome(state, home)
  await checkTree(home, state.env)
  await verify(owner)
  await verifyHome(state, home)
  await rm(home, { recursive: true })
  state.record.home = null
  await saveMarker(state)
}

export async function cleanupOwnedTestRoot(owner) {
  const state = await verify(owner)
  if (state.record.home) await verifyHome(state, state.record.home.path)
  await checkTree(state.path, state.env)
  await verify(owner)
  await rm(state.path, { recursive: true })
  owners.delete(owner)
}
