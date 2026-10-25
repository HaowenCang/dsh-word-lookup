import { Worker } from 'node:worker_threads'

/** Instrument the real emitted companion, without changing its dispatch or responses. */
export async function runPublishedCustomWorker(request: unknown): Promise<{
  messages: any[]
  calls: { vacuum: number; validation: number; hashOpen: number; unlink: number }
  exitCode: number
}> {
  const bundle = new URL('../lib/ecdict-integrity-worker.js', import.meta.url).href
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const { DatabaseSync } = require('node:sqlite');
    const { syncBuiltinESMExports } = require('node:module');
    const calls = { vacuum: 0, validation: 0, hashOpen: 0, unlink: 0 };
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql, ...args) {
      if (/^VACUUM INTO /i.test(sql)) calls.vacuum++;
      return exec.call(this, sql, ...args);
    };
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql, ...args) {
      if (sql === 'PRAGMA integrity_check(100)') calls.validation++;
      return prepare.call(this, sql, ...args);
    };
    const open = fs.openSync;
    fs.openSync = function(path, ...args) {
      if (path === workerData.stagingPath || path === workerData.snapshotPath) calls.hashOpen++;
      return open.call(this, path, ...args);
    };
    const unlink = fs.unlinkSync;
    fs.unlinkSync = function(path, ...args) {
      if (path === workerData.stagingPath) calls.unlink++;
      return unlink.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    import(${JSON.stringify(bundle)}).then(() => parentPort.postMessage({ testObservation: calls }));
  `, { eval: true, workerData: request, execArgv: [] })
  const messages: any[] = []
  let calls: any
  let workerError: Error | undefined
  return new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message?.testObservation) calls = message.testObservation
      else messages.push(message)
    })
    worker.on('error', (error) => { workerError = error })
    worker.on('exit', (exitCode) => {
      if (workerError) reject(workerError)
      else resolve({ messages, calls, exitCode })
    })
  })
}
