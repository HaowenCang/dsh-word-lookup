import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CustomDictionaryValidator } from '../src/host/custom-dictionary-validator.js'
import { CustomSnapshotManager } from '../src/host/custom-snapshot-manager.js'
import { DictionaryManager } from '../src/host/dictionary-manager.js'
import { resolveManagedStoragePaths, ensureManagedStorageDirectories } from '../src/host/managed-storage.js'
import { ActivationCoordinator } from '../src/host/dictionary-activation.js'
import { DictionaryOperationManager } from '../src/host/dictionary-operations.js'
import { openFixtureDictionary } from '../src/host/fixture-db.js'
const source = { CustomDictionaryValidator, CustomSnapshotManager, DictionaryManager, resolveManagedStoragePaths, ensureManagedStorageDirectories, ActivationCoordinator, DictionaryOperationManager, openFixtureDictionary }
const emitted = await import(new URL('../lib/index.js', import.meta.url).href) as typeof source
const pause = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))
async function bounded<T>(p: Promise<T>): Promise<T | 'PUBLIC_WAIT_EXCEEDED'> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([p, new Promise<'PUBLIC_WAIT_EXCEEDED'>(r => { timer = setTimeout(() => r('PUBLIC_WAIT_EXCEEDED'), 700) })]) }
  finally { clearTimeout(timer!) }
}
function adapter(mode: string) {
  const worker = new EventEmitter() as any
  let rejectLate!: (e: Error) => void
  worker.terminate = mode === 'throw' ? () => { throw new Error('adapter terminate throw') }
    : mode === 'reject' ? () => Promise.reject(new Error('adapter terminate reject'))
    : mode === 'resolve' ? () => Promise.resolve(0)
    : () => new Promise<number>((_, reject) => { rejectLate = reject })
  return { worker, lateReject: () => rejectLate?.(new Error('late adapter rejection')) }
}
const success = (r: any) => ({ action:r.action,requestId:r.requestId,success:true,sha256:'a'.repeat(64),byteSize:1,durationMs:1 })
// These tests catch early physical-capacity release, unbounded termination and unsafe manager cleanup.
// All EventEmitter exits are explicitly synthetic adapter evidence, never native reproduction.
describe.each([['source', source], ['emitted Host', emitted]] as const)('RISK001 %s', (_, api) => {
  it.each(['pending','reject','throw','resolve'])('timeout retains physical tracking and refuses queued callers (%s adapter)', async mode => {
    const a = adapter(mode); let spawned = 0
    const v = new api.CustomDictionaryValidator({ terminationTimeoutMs:20, workerAdapter:() => { spawned++; return a.worker } } as any)
    const first = v.createSnapshot('unused-source','unused-staging',{timeoutMs:5}).catch(e=>e)
    const queued = v.createSnapshot('unused-source','unused-staging').catch(e=>e)
    try {
      const error = await bounded(first)
      expect(error).toMatchObject({code:'TERMINATION_UNCONFIRMED',terminationStatus:'TERMINATION_UNCONFIRMED',cause:{code:'TIMEOUT'}})
      expect(await bounded(queued)).toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      expect(v.runningCount).toBe(1); expect(spawned).toBe(1)
      expect((v as any).isPathInUse('unused-staging')).toBe(true)
      await expect(v.dispose()).rejects.toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      await expect(v.dispose()).rejects.toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      a.lateReject(); a.worker.emit('error',new Error('late adapter error')); await pause()
      expect(v.runningCount).toBe(1)
      a.worker.emit('exit',1); await pause()
      expect(v.runningCount).toBe(0); expect((v as any).isPathInUse('unused-staging')).toBe(false)
      expect(a.worker.listenerCount('message')).toBe(0); expect(a.worker.listenerCount('exit')).toBe(0)
      await v.dispose()
    } finally { a.worker.emit('exit',1); await v.dispose().catch(()=>{}) }
  })
  it.each(['cancel','error','dispose'])('bounds %s and preserves the primary failure with pending terminate', async trigger => {
    const a=adapter('pending'), ctrl=new AbortController()
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:15,workerAdapter:()=>a.worker} as any)
    const p=v.createSnapshot('unused','unused-stage',{signal:ctrl.signal}).catch(e=>e)
    let disposal: Promise<unknown> | undefined
    if(trigger==='cancel') ctrl.abort(); else if(trigger==='error') a.worker.emit('error',new Error('primary worker error')); else disposal=v.dispose().catch(e=>e)
    try {
      expect(await bounded(p)).toMatchObject({code:'TERMINATION_UNCONFIRMED',cause:{code:trigger==='cancel'?'CANCELLED':trigger==='error'?'WORKER_ERROR':'HOST_DISPOSED'}})
      if(disposal) expect(await bounded(disposal)).toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      a.worker.emit('exit',1); await v.dispose()
    } finally {a.worker.emit('exit',1); await v.dispose().catch(()=>{})}
  })
  it.each(['pending','reject'])('genuine observed exit settles valid success without waiting for irrelevant %s terminate', async mode => {
    const a=adapter(mode)
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:15,workerAdapter:(r:any)=>{queueMicrotask(()=>{a.worker.emit('message',success(r)); a.worker.emit('exit',0)});return a.worker}} as any)
    try {expect(await bounded(v.createSnapshot('unused','unused-stage'))).toMatchObject({success:true}); expect(v.runningCount).toBe(0)}
    finally {a.worker.emit('exit',0);await v.dispose().catch(()=>{})}
  })
  it('success IPC without exit cannot become success or release capacity', async () => {
    const a=adapter('pending')
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:15,workerAdapter:(r:any)=>{queueMicrotask(()=>a.worker.emit('message',success(r)));return a.worker}} as any)
    try {expect(await bounded(v.createSnapshot('unused','unused-stage',{timeoutMs:5}).catch(e=>e))).toMatchObject({code:'TERMINATION_UNCONFIRMED'});expect(v.runningCount).toBe(1)}
    finally {a.worker.emit('exit',0);await v.dispose().catch(()=>{})}
  })
  it.each(['pending','reject'])('actual manager retains staging and owner through %s termination and retryable disposal', async mode => {
    const root=join(tmpdir(),'risk001-manager-'+randomUUID());mkdirSync(root)
    const paths=api.resolveManagedStoragePaths({home:root}); await api.ensureManagedStorageDirectories(paths)
    const raw=join(root,'source.sqlite3');copyFileSync(new URL('../fixtures/dictionary.fixture.db',import.meta.url),raw)
    const digest=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex')
    const hash=digest(raw),size=statSync(raw).size
    const a=adapter(mode)
    const native=new api.CustomDictionaryValidator()
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:15,workerAdapter:(r:any)=>{copyFileSync(r.sourcePath,r.stagingPath);return a.worker}} as any)
    const m=new api.CustomSnapshotManager({paths,validator:v}), other=new api.CustomSnapshotManager({paths})
    const good=new api.CustomSnapshotManager({paths,validator:native})
    const initial=await good.createAndPublishSnapshot(raw,{identity:'old-active'})
    const active=new api.DictionaryManager({mode:'custom',identity:'old-active',dictionary:good.openSnapshotDictionary(initial.id)})
    const before=active.snapshot(), catalog=readFileSync(paths.customSnapshotCatalogPath), initialHash=digest(initial.publishedPath!)
    try {
      const result=await bounded(m.createAndPublishSnapshot(raw,{identity:'uncertain',timeoutMs:5}).catch(e=>e))
      expect(result).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      const record=m.getSnapshotByIdentity('uncertain')!
      expect(record).toMatchObject({state:'CLEANUP_PENDING',errorCode:'TERMINATION_UNCONFIRMED',publishedPath:null})
      expect(existsSync(record.stagingPath)).toBe(true);expect(existsSync(record.stagingPath+'.owner')).toBe(true)
      expect(m.isStagingActive(record.stagingPath)).toBe(true);expect(v.runningCount).toBe(1)
      const disposals=await Promise.all([m.dispose().catch(e=>e),m.dispose().catch(e=>e)])
      disposals.forEach(e=>expect(e).toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'}))
      expect(await other.cleanupStagingFiles()).toBe(0);expect(existsSync(record.stagingPath)).toBe(true);expect(existsSync(record.stagingPath+'.owner')).toBe(true)
      expect(active.snapshot()).toEqual(before);expect(active.lookup('derive').found).toBe(true);expect(good.getActiveLeases(initial.id)).toBe(1)
      expect(readFileSync(paths.customSnapshotCatalogPath)).toEqual(catalog);expect(digest(initial.publishedPath!)).toBe(initialHash)
      a.worker.emit('exit',1);await pause();await m.dispose()
      expect(existsSync(record.stagingPath)).toBe(false);expect(existsSync(record.stagingPath+'.owner')).toBe(false)
      expect(digest(raw)).toBe(hash);expect(statSync(raw).size).toBe(size)
    } finally {a.worker.emit('exit',1);active.close();await Promise.allSettled([m.dispose(),other.dispose(),good.dispose()]);rmSync(root,{recursive:true,force:true})}
  })
  it('queued cancellation settles before the running worker and late exit permits fresh work', async () => {
    const a=adapter('pending');let count=0
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:10,workerAdapter:(r:any)=>{
      if (++count===1) return a.worker
      const b=adapter('pending');queueMicrotask(()=>{b.worker.emit('message',success(r));b.worker.emit('exit',0)});return b.worker
    }} as any)
    const first=v.createSnapshot('unused','unused-stage',{timeoutMs:20}).catch(e=>e)
    const ctrl=new AbortController(),second=v.createSnapshot('unused','unused-stage',{signal:ctrl.signal}).catch(e=>e)
    ctrl.abort()
    try {
      expect(await bounded(second)).toMatchObject({code:'CANCELLED'})
      expect(await bounded(first)).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      expect(await bounded(v.createSnapshot('unused','unused-stage').catch(e=>e))).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      a.worker.emit('exit',undefined);expect(v.runningCount).toBe(1)
      a.worker.emit('exit',1)
      expect(await bounded(v.createSnapshot('unused','unused-stage'))).toMatchObject({success:true})
      expect(v.runningCount).toBe(0)
    } finally {a.worker.emit('exit',1);await v.dispose()}
  })
  it.each(['file','owner','owner-content'])('late-exit recovery refuses a replacement %s at the same path', async target => {
    const root=join(tmpdir(),'risk001-replacement-'+randomUUID());mkdirSync(root)
    const paths=api.resolveManagedStoragePaths({home:root});await api.ensureManagedStorageDirectories(paths)
    const raw=join(root,'source.sqlite3');copyFileSync(new URL('../fixtures/dictionary.fixture.db',import.meta.url),raw)
    const a=adapter('pending'),v=new api.CustomDictionaryValidator({terminationTimeoutMs:10,workerAdapter:(r:any)=>{copyFileSync(r.sourcePath,r.stagingPath);return a.worker}} as any)
    const m=new api.CustomSnapshotManager({paths,validator:v}), other=new api.CustomSnapshotManager({paths})
    let replaced='',backup='',ownerBefore:Buffer|undefined
    try {
      expect(await bounded(m.createAndPublishSnapshot(raw,{identity:'replacement',timeoutMs:5}).catch(e=>e))).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      const record=m.getSnapshotByIdentity('replacement')!
      replaced=record.stagingPath+(target.startsWith('owner')?'.owner':'');
      if(target==='owner-content') ownerBefore=readFileSync(replaced)
      else {backup=replaced+'.held';renameSync(replaced,backup)}
      writeFileSync(replaced,'replacement must survive')
      a.worker.emit('exit',1)
      await expect(m.dispose()).rejects.toMatchObject({code:'SNAPSHOT_CLEANUP_FAILED'})
      expect(readFileSync(replaced,'utf8')).toBe('replacement must survive')
      expect(await other.cleanupStagingFiles({allowUnverifiedRecovery:true})).toBe(0)
      expect(readFileSync(replaced,'utf8')).toBe('replacement must survive')
      if(ownerBefore) {writeFileSync(replaced,ownerBefore);ownerBefore=undefined}
      else {rmSync(replaced);renameSync(backup,replaced);backup=''}
      await m.dispose()
      expect(existsSync(record.stagingPath)).toBe(false);expect(existsSync(record.stagingPath+'.owner')).toBe(false)
    } finally {a.worker.emit('exit',1);if(ownerBefore)writeFileSync(replaced,ownerBefore);if(backup&&existsSync(backup)){rmSync(replaced,{force:true});renameSync(backup,replaced)}await Promise.allSettled([m.dispose(),other.dispose()]);rmSync(root,{recursive:true,force:true})}
  })
  it('operation disposal propagates custom uncertainty and retries after late exit', async () => {
    const root=join(tmpdir(),'risk001-operation-'+randomUUID());mkdirSync(root)
    const paths=api.resolveManagedStoragePaths({home:root});await api.ensureManagedStorageDirectories(paths)
    const raw=join(root,'source.sqlite3');copyFileSync(new URL('../fixtures/dictionary.fixture.db',import.meta.url),raw)
    const a=adapter('pending'),v=new api.CustomDictionaryValidator({terminationTimeoutMs:10,workerAdapter:(r:any)=>{copyFileSync(r.sourcePath,r.stagingPath);return a.worker}} as any)
    const m=new api.CustomSnapshotManager({paths,validator:v})
    const dictionary=new api.DictionaryManager({mode:'fixture',identity:'fixture',dictionary:api.openFixtureDictionary()})
    const coordinator=new api.ActivationCoordinator({paths,manager:dictionary,customSnapshotManager:m})
    const operations=new api.DictionaryOperationManager({paths,activationCoordinator:coordinator})
    const task=operations.activateCustom(raw,'operation').catch(e=>e)
    try {
      // Wait only for this owned adapter to have been spawned; never discover external processes.
      for(let i=0;i<150&&v.runningCount===0;i++) await pause(1)
      expect(v.runningCount).toBe(1)
      expect(await bounded(operations.dispose().catch(e=>e))).toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      expect(await bounded(task)).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      expect(operations.getDrainSummary()).toMatchObject({statusUnknown:true,workerExited:false})
      await expect(operations.dispose()).rejects.toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      const record=m.getSnapshotByIdentity('operation')!;expect(existsSync(record.stagingPath)).toBe(true)
      a.worker.emit('exit',1);await operations.dispose()
      expect(operations.getDrainSummary()).toMatchObject({statusUnknown:false})
      expect(existsSync(record.stagingPath)).toBe(false)
    } finally {a.worker.emit('exit',1);await operations.dispose().catch(()=>{});dictionary.close();rmSync(root,{recursive:true,force:true})}
  })

  it('cancellation synchronously raised by the adapter cannot release the returned live Worker', async () => {
    const a=adapter('pending'),ctrl=new AbortController()
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:10,workerAdapter:()=>{ctrl.abort();return a.worker}} as any)
    try {
      expect(await bounded(v.createSnapshot('unused','unused-stage',{signal:ctrl.signal}).catch(e=>e))).toMatchObject({code:'TERMINATION_UNCONFIRMED',cause:{code:'CANCELLED'}})
      expect(v.runningCount).toBe(1);expect((v as any).isPathInUse('unused-stage')).toBe(true)
      a.worker.emit('exit',1);expect(v.runningCount).toBe(0)
    } finally {a.worker.emit('exit',1);await v.dispose().catch(()=>{})}
  })

  it.each(['pending','reject','throw'])('actual companion staging survives injected %s terminate until native exit', async mode => {
    const root=join(tmpdir(),'risk001-owned-worker-'+randomUUID());mkdirSync(root)
    const paths=api.resolveManagedStoragePaths({home:root});await api.ensureManagedStorageDirectories(paths)
    const raw=join(root,'source.sqlite3');copyFileSync(new URL('../fixtures/dictionary.fixture.db',import.meta.url),raw)
    const ctrl=new AbortController();let stop!:()=>Promise<number>,nativeExit:number|undefined,reply:any
    const validator=new api.CustomDictionaryValidator({terminationTimeoutMs:15,workerAdapter:(request:any)=>{
      const companion=new URL('../lib/ecdict-integrity-worker.js',import.meta.url).href
      const worker=new Worker('setInterval(()=>{},1000);import('+JSON.stringify(companion)+')',{eval:true,workerData:request,execArgv:[]})
      stop=worker.terminate.bind(worker)
      worker.on('message',value=>{reply=value;ctrl.abort()});worker.on('exit',code=>{nativeExit=code})
      worker.terminate=mode==='pending'?()=>new Promise<number>(()=>{}):mode==='reject'?()=>Promise.reject(new Error('injected rejection')):()=>{throw new Error('injected throw')}
      return worker
    }} as any)
    const manager=new api.CustomSnapshotManager({paths,validator}),scanner=new api.CustomSnapshotManager({paths})
    try {
      const error=await manager.createAndPublishSnapshot(raw,{identity:'actual-companion',signal:ctrl.signal,timeoutMs:3000}).catch(e=>e)
      expect(error).toMatchObject({code:'TERMINATION_UNCONFIRMED',cause:{code:'CANCELLED'}})
      expect(reply).toMatchObject({success:true,byteSize:45056});expect(nativeExit).toBeUndefined();expect(validator.runningCount).toBe(1)
      const record=manager.getSnapshotByIdentity('actual-companion')!
      expect(existsSync(record.stagingPath)).toBe(true);expect(existsSync(record.stagingPath+'.owner')).toBe(true)
      await expect(manager.dispose()).rejects.toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      expect(await scanner.cleanupStagingFiles()).toBe(0);expect(existsSync(record.stagingPath)).toBe(true)
      await stop();expect(nativeExit).toBe(1);expect(validator.runningCount).toBe(0)
      await manager.dispose();expect(existsSync(record.stagingPath)).toBe(false);expect(existsSync(record.stagingPath+'.owner')).toBe(false)
    } finally {if(stop)await stop();await Promise.allSettled([manager.dispose(),scanner.dispose()]);rmSync(root,{recursive:true,force:true})}
  })
  it.each(['pending','reject'])('actual activation validation cannot commit with %s exit uncertainty', async mode => {
    const root=join(tmpdir(),'risk001-activation-'+randomUUID());mkdirSync(root)
    const paths=api.resolveManagedStoragePaths({home:root});await api.ensureManagedStorageDirectories(paths)
    const raw=join(root,'source.sqlite3');copyFileSync(new URL('../fixtures/dictionary.fixture.db',import.meta.url),raw)
    const good=new api.CustomSnapshotManager({paths}),a=adapter(mode)
    const initial=await good.createAndPublishSnapshot(raw,{identity:'old-active'}),candidate=await good.createAndPublishSnapshot(raw,{identity:'dormant-candidate'})
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:10,workerAdapter:()=>a.worker} as any)
    const m=new api.CustomSnapshotManager({paths,validator:v})
    await m.adoptPublishedSnapshot(candidate.id,{identity:'dormant-candidate',publishedPath:candidate.publishedPath!,sha256:candidate.sha256!,byteSize:candidate.byteSize!,schemaVersion:1})
    const dictionary=new api.DictionaryManager({mode:'custom',identity:'old-active',dictionary:good.openSnapshotDictionary(initial.id)})
    const coordinator=new api.ActivationCoordinator({paths,manager:dictionary,customSnapshotManager:m})
    const before=dictionary.snapshot(),catalog=readFileSync(paths.customSnapshotCatalogPath),ctrl=new AbortController()
    const task=coordinator.activateCustomDatabase(candidate.id,{signal:ctrl.signal}).catch(e=>e)
    try {
      for(let i=0;i<150&&v.runningCount===0;i++) await pause(1)
      expect(v.runningCount).toBe(1);ctrl.abort()
      expect(await bounded(task)).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      expect(m.getSnapshot(candidate.id)).toMatchObject({state:'REJECTED',errorCode:'TERMINATION_UNCONFIRMED'})
      expect(dictionary.snapshot()).toEqual(before);expect(dictionary.lookup('derive').found).toBe(true);expect(good.getActiveLeases(initial.id)).toBe(1)
      expect(m.canCleanupSnapshot(candidate.id)).toBe(false);await expect(m.cleanupSnapshot(candidate.id)).rejects.toBeDefined()
      expect(good.canCleanupSnapshot(candidate.id)).toBe(false)
      await expect(good.cleanupSnapshot(candidate.id)).rejects.toBeDefined()
      expect(existsSync(candidate.publishedPath!)).toBe(true);expect(readFileSync(paths.customSnapshotCatalogPath)).toEqual(catalog)
      await expect(coordinator.dispose()).rejects.toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      a.worker.emit('exit',1);await coordinator.dispose();expect(existsSync(candidate.publishedPath!)).toBe(true)
    } finally {a.worker.emit('exit',1);dictionary.close();await Promise.allSettled([coordinator.dispose(),good.dispose()]);rmSync(root,{recursive:true,force:true})}
  })

  it.skipIf(process.platform !== 'win32')('Windows case aliases retain staging and owner until genuine native late exit', async () => {
    const root=join(tmpdir(),'risk001-case-alias-'+randomUUID());mkdirSync(root)
    const homeA=join(root,'CaseHome'),homeB=join(root,'casehome')
    const pathsA=api.resolveManagedStoragePaths({home:homeA}),pathsB=api.resolveManagedStoragePaths({home:homeB})
    await api.ensureManagedStorageDirectories(pathsA)
    expect(pathsA.customSnapshotDirectory).not.toBe(pathsB.customSnapshotDirectory)
    expect(statSync(homeA).ino).toBeGreaterThan(0);expect(statSync(homeA).ino).toBe(statSync(homeB).ino);expect(statSync(homeA).dev).toBe(statSync(homeB).dev)
    const raw=join(root,'source.sqlite3');copyFileSync(new URL('../fixtures/dictionary.fixture.db',import.meta.url),raw)
    const hash=createHash('sha256').update(readFileSync(raw)).digest('hex'),size=statSync(raw).size
    const ctrl=new AbortController();let stop!:()=>Promise<number>,nativeExit:number|undefined
    // Real companion work; only terminate is injected pending. This is adapter-fault evidence.
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:15,workerAdapter:(request:any)=>{
      const companion=new URL('../lib/ecdict-integrity-worker.js',import.meta.url).href
      const worker=new Worker('setInterval(()=>{},1000);import('+JSON.stringify(companion)+')',{eval:true,workerData:request,execArgv:[]})
      stop=worker.terminate.bind(worker)
      worker.on('message',()=>ctrl.abort());worker.on('exit',code=>{nativeExit=code})
      worker.terminate=()=>new Promise<number>(()=>{})
      return worker
    }} as any)
    const m=new api.CustomSnapshotManager({paths:pathsA,validator:v}),scanner=new api.CustomSnapshotManager({paths:pathsB})
    try {
      expect(await m.createAndPublishSnapshot(raw,{identity:'case-retained',signal:ctrl.signal,timeoutMs:5000}).catch(e=>e)).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      const record=m.getSnapshotByIdentity('case-retained')!,alias=join(pathsB.customSnapshotDirectory,basename(record.stagingPath))
      const ownerBefore=readFileSync(record.stagingPath+'.owner')
      expect.soft(v.isPathInUse(alias)).toBe(true);expect.soft(m.isStagingActive(alias)).toBe(true)
      expect(nativeExit).toBeUndefined();expect(v.runningCount).toBe(1)
      await expect(m.dispose()).rejects.toMatchObject({terminationStatus:'TERMINATION_UNCONFIRMED'})
      expect.soft(m.isStagingActive(alias)).toBe(true)
      expect.soft(await scanner.cleanupStagingFiles({allowUnverifiedRecovery:true})).toBe(0)
      expect.soft(existsSync(record.stagingPath)).toBe(true);expect.soft(existsSync(record.stagingPath+'.owner')).toBe(true)
      if(existsSync(record.stagingPath+'.owner'))expect(readFileSync(record.stagingPath+'.owner')).toEqual(ownerBefore)
      expect(v.runningCount).toBe(1)
      await stop();expect(nativeExit).toBe(1);expect(v.runningCount).toBe(0);expect(v.isPathInUse(alias)).toBe(false)
      await m.dispose();expect(m.isStagingActive(alias)).toBe(false)
      expect(existsSync(alias)).toBe(false);expect(existsSync(alias+'.owner')).toBe(false)
      expect(await scanner.cleanupStagingFiles()).toBe(0)
      expect(createHash('sha256').update(readFileSync(raw)).digest('hex')).toBe(hash);expect(statSync(raw).size).toBe(size)
    } finally {if(stop)await stop();await Promise.allSettled([m.dispose(),scanner.dispose()]);rmSync(root,{recursive:true,force:true})}
  })
  it.skipIf(process.platform !== 'win32')('Windows case aliases protect held published cleanup, activation and open', async () => {
    const root=join(tmpdir(),'risk001-published-case-'+randomUUID());mkdirSync(root)
    const pathsA=api.resolveManagedStoragePaths({home:join(root,'CaseHome')}),pathsB=api.resolveManagedStoragePaths({home:join(root,'casehome')})
    await api.ensureManagedStorageDirectories(pathsA)
    expect(statSync(pathsA.customSnapshotDirectory).ino).toBeGreaterThan(0);expect(statSync(pathsA.customSnapshotDirectory).ino).toBe(statSync(pathsB.customSnapshotDirectory).ino)
    const raw=join(root,'source.sqlite3');copyFileSync(new URL('../fixtures/dictionary.fixture.db',import.meta.url),raw)
    const a=adapter('pending'),v=new api.CustomDictionaryValidator({terminationTimeoutMs:10,workerAdapter:()=>a.worker} as any)
    const good=new api.CustomSnapshotManager({paths:pathsA}),holder=new api.CustomSnapshotManager({paths:pathsA,validator:v}),aliasManager=new api.CustomSnapshotManager({paths:pathsB})
    try {
      const candidate=await good.createAndPublishSnapshot(raw,{identity:'case-candidate'})
      const alias=join(pathsB.customSnapshotDirectory,basename(candidate.publishedPath!))
      await aliasManager.adoptPublishedSnapshot(candidate.id,{identity:'case-candidate',publishedPath:alias,sha256:candidate.sha256!,byteSize:candidate.byteSize!,schemaVersion:1})
      const catalog=readFileSync(pathsA.customSnapshotCatalogPath)
      expect(await bounded(holder.validatePublishedSnapshot(candidate.publishedPath!,{timeoutMs:5}).catch(e=>e))).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      expect.soft(v.isPathInUse(alias)).toBe(true);expect.soft(aliasManager.canCleanupSnapshot(candidate.id)).toBe(false)
      const activation=await aliasManager.validatePublishedSnapshotForActivation(candidate.id).then(d=>{d.close();return 'opened'},e=>e)
      expect.soft(activation).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      try {const d=aliasManager.openSnapshotDictionary(candidate.id);d.close();expect.soft('opened').toBe('refused')}catch(e){expect.soft(e).toMatchObject({code:'TERMINATION_UNCONFIRMED'})}
      const cleanup=await aliasManager.cleanupSnapshot(candidate.id).then(()=> 'deleted',e=>e)
      expect.soft(cleanup).not.toBe('deleted');expect.soft(existsSync(alias)).toBe(true)
      expect.soft(readFileSync(pathsA.customSnapshotCatalogPath)).toEqual(catalog)
      a.worker.emit('exit',1);expect(v.isPathInUse(alias)).toBe(false)
      if(existsSync(alias)){expect(await aliasManager.cleanupSnapshot(candidate.id)).toBe(true);expect(existsSync(alias)).toBe(false)}
    } finally {a.worker.emit('exit',1);await Promise.allSettled([holder.dispose(),good.dispose(),aliasManager.dispose()]);rmSync(root,{recursive:true,force:true})}
  })

  it.each([-1,-2])('native Worker exit %s releases paths and capacity without terminate override', async exitCode => {
    const nativeExits:number[]=[];let owned=0;const workers:Worker[]=[]
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:20,workerAdapter:()=>{
      // No terminate replacement: this is native exit-domain evidence, not native terminate failure.
      const worker=new Worker('process.exit('+exitCode+')',{eval:true,execArgv:[]})
      owned++;workers.push(worker);worker.on('exit',code=>{nativeExits.push(code);owned--})
      return worker
    }} as any)
    try {
      const error=await bounded(v.createSnapshot('unused-native-source','unused-native-stage',{timeoutMs:1000}).catch(e=>e))
      expect(error).toMatchObject({code:'WORKER_CRASHED',exitCode})
      expect(nativeExits).toEqual([exitCode]);expect(owned).toBe(0)
      expect(v.runningCount).toBe(0);expect(v.isPathInUse('unused-native-stage')).toBe(false)
      expect(v.hasUnconfirmedWorkers).toBe(false)
      // Subsequent work must be admitted, rather than rejected by stale uncertainty.
      expect(await bounded(v.createSnapshot('next-native-source','next-native-stage',{timeoutMs:1000}).catch(e=>e))).toMatchObject({code:'WORKER_CRASHED',exitCode})
      expect(nativeExits).toEqual([exitCode,exitCode]);expect(owned).toBe(0);expect(v.runningCount).toBe(0)
      await v.dispose();await v.dispose()
    } finally {await Promise.allSettled(workers.map(w=>w.terminate()));await v.dispose().catch(()=>{})}
  })
  it.each(['success','protocol'])('negative synthetic exit preserves %s failure rules and release', async outcome => {
    const a=adapter('pending')
    const v=new api.CustomDictionaryValidator({terminationTimeoutMs:15,workerAdapter:(r:any)=>{queueMicrotask(()=>{
      a.worker.emit('message',outcome==='success'?success(r):{...success(r),requestId:'wrong-id'})
      a.worker.emit('exit',-2)
    });return a.worker}} as any)
    try {
      const error=await bounded(v.createSnapshot('unused','unused-stage',{timeoutMs:30}).catch(e=>e))
      expect(error).toMatchObject(outcome==='success'?{code:'WORKER_CRASHED',exitCode:-2}:{code:'WORKER_PROTOCOL_ERROR'})
      expect(v.runningCount).toBe(0);expect(v.isPathInUse('unused-stage')).toBe(false);await v.dispose()
    } finally {a.worker.emit('exit',1);await v.dispose().catch(()=>{})}
  })
  it('malformed exit payloads remain unconfirmed while a later negative integer exit reclaims', async () => {
    const a=adapter('pending'),v=new api.CustomDictionaryValidator({terminationTimeoutMs:10,workerAdapter:()=>a.worker} as any)
    const p=v.createSnapshot('unused','unused-stage',{timeoutMs:5}).catch(e=>e)
    try {
      for(const payload of [undefined,null,'0',NaN,0.5,Infinity])a.worker.emit('exit',payload)
      expect(v.runningCount).toBe(1);expect(v.isPathInUse('unused-stage')).toBe(true)
      expect(await bounded(p)).toMatchObject({code:'TERMINATION_UNCONFIRMED'})
      a.worker.emit('exit',-1)
      expect(v.runningCount).toBe(0);expect(v.isPathInUse('unused-stage')).toBe(false)
      expect(await p).toMatchObject({code:'TERMINATION_UNCONFIRMED'});await v.dispose()
    } finally {a.worker.emit('exit',1);await v.dispose().catch(()=>{})}
  })

})
