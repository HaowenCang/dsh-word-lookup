import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { CustomDictionaryValidator } from '../src/host/custom-dictionary-validator.js'
import type { CompanionWorkerRequest } from '../src/host/ecdict-integrity-worker.js'
import type { WorkerLike } from '../src/host/ecdict-integrity-verifier.js'

const { CustomDictionaryValidator: PublishedCustomDictionaryValidator } = await import(
  new URL('../lib/index.js', import.meta.url).href
) as typeof import('../src/host/custom-dictionary-validator.js')

function success(request: CompanionWorkerRequest) {
  return { action: 'CUSTOM_SNAPSHOT_CREATE', requestId: request.requestId, success: true, sha256: 'a'.repeat(64), byteSize: 4096, durationMs: 1 }
}

describe.each([
  ['source', CustomDictionaryValidator],
  ['published host', PublishedCustomDictionaryValidator],
])('Custom worker protocol (%s): identity, shape, uniqueness and exit barrier', (_target, Validator) => {
  const invalidCases: Array<[string, (request: CompanionWorkerRequest) => unknown[]]> = [
    ['duplicate success', (request) => [success(request), success(request)]],
    ['success followed by failure', (request) => [success(request), { action: 'CUSTOM_SNAPSHOT_CREATE', requestId: request.requestId, success: false, errorCode: 'SNAPSHOT_FAILED', message: 'late failure' }]],
    ['wrong requestId', (request) => [{ ...success(request), requestId: 'another-request' }]],
    ['wrong action', (request) => [{ ...success(request), action: 'CUSTOM_SNAPSHOT_VALIDATE' }]],
    ['unknown action', (request) => [{ ...success(request), action: 'UNKNOWN_ACTION' }]],
    ['missing digest', (request) => [{ ...success(request), sha256: undefined }]],
    ['invalid size', (request) => [{ ...success(request), byteSize: -1 }]],
    ['invalid duration', (request) => [{ ...success(request), durationMs: NaN }]],
    ['malformed failure', (request) => [{ action: 'CUSTOM_SNAPSHOT_CREATE', requestId: request.requestId, success: false, errorCode: 123, message: 'bad failure' }]],
    ['null response', () => [null]],
  ]

  it.each(invalidCases)('rejects %s as protocol error after exit', async (_name, responses) => {
    let worker!: EventEmitter & WorkerLike
    let exit!: () => void
    const validator = new Validator({ workerAdapter: (request) => {
      worker = new EventEmitter() as EventEmitter & WorkerLike
      worker.terminate = async () => 0
      exit = () => worker.emit('exit', 0)
      setImmediate(() => responses(request).forEach((response) => worker.emit('message', response)))
      return worker
    } })
    let settled = false
    const pending = validator.createSnapshot('unused-source', 'unused-staging').then(
      (value) => { settled = true; return value },
      (error) => { settled = true; throw error },
    )
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WORKER_PROTOCOL_ERROR' })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(validator.runningCount).toBe(1)
      exit()
      await rejected
      expect(validator.runningCount).toBe(0)
    } finally { await validator.dispose() }
  })

  it('keeps a valid success pending until the actual exit event', async () => {
    let exit!: () => void
    const validator = new Validator({ workerAdapter: (request) => {
      const worker = new EventEmitter() as EventEmitter & WorkerLike
      worker.terminate = async () => 0
      exit = () => worker.emit('exit', 0)
      setImmediate(() => worker.emit('message', success(request)))
      return worker
    } })
    let settled = false
    const pending = validator.createSnapshot('unused-source', 'unused-staging').then((value) => { settled = true; return value })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(validator.runningCount).toBe(1)
      exit()
      await expect(pending).resolves.toMatchObject({ success: true, byteSize: 4096 })
      expect(validator.runningCount).toBe(0)
    } finally { await validator.dispose() }
  })

  it('rejects a valid success followed by abnormal exit', async () => {
    const validator = new Validator({ workerAdapter: (request) => {
      const worker = new EventEmitter() as EventEmitter & WorkerLike
      worker.terminate = async () => 9
      setImmediate(() => { worker.emit('message', success(request)); worker.emit('exit', 9) })
      return worker
    } })
    try {
      await expect(validator.createSnapshot('unused-source', 'unused-staging')).rejects.toMatchObject({ code: 'WORKER_CRASHED', exitCode: 9 })
    } finally { await validator.dispose() }
  })

  it.each(['CUSTOM_SNAPSHOT_VALIDATE', 'CUSTOM_SNAPSHOT_PRE_PUBLISH_CHECK'])('rejects missing action-specific fields for %s', async (action) => {
    const validator = new Validator({ workerAdapter: (request) => {
      const worker = new EventEmitter() as EventEmitter & WorkerLike
      worker.terminate = async () => 0
      setImmediate(() => { worker.emit('message', { ...success(request), action }); worker.emit('exit', 0) })
      return worker
    } })
    try {
      const result = action === 'CUSTOM_SNAPSHOT_VALIDATE'
        ? validator.validateSnapshot('unused')
        : validator.prePublishCheck('unused', 'a'.repeat(64), 4096)
      await expect(result).rejects.toMatchObject({ code: 'WORKER_PROTOCOL_ERROR' })
    } finally { await validator.dispose() }
  })

  it('preserves classified failure compatibility when durationMs is omitted', async () => {
    const validator = new Validator({ workerAdapter: (request) => {
      const worker = new EventEmitter() as EventEmitter & WorkerLike
      worker.terminate = async () => 0
      setImmediate(() => { worker.emit('message', { action: 'CUSTOM_SNAPSHOT_CREATE', requestId: request.requestId, success: false, errorCode: 'SNAPSHOT_FAILED', message: 'expected failure' }); worker.emit('exit', 0) })
      return worker
    } })
    try {
      await expect(validator.createSnapshot('unused', 'unused')).rejects.toMatchObject({ code: 'SNAPSHOT_FAILED' })
    } finally { await validator.dispose() }
  })
})
