import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import { join,resolve,basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('.',import.meta.url)), repo=join(root,'repo'), dest=process.argv[2]?resolve(root,process.argv[2]):join(root,'candidate-final')
const reportName=process.argv[3]??'final-artifact.json'
if(basename(reportName)!==reportName)throw new Error('report name must be a filename')
const tgz=join(dest,'dsh-word-lookup-0.2.2.tgz'), bytes=readFileSync(tgz)
const sha=b=>createHash('sha256').update(b).digest('hex')
const expected=['LICENSE','README.md','cordis.patch.yml','corpus/ecdict.manifest.json','lib/client.js','lib/ecdict-integrity-worker.js','lib/index.js','package.json']
const members=execFileSync('tar.exe',['-tzf',tgz],{encoding:'utf8'}).trim().split(/\r?\n/).sort()
if(JSON.stringify(members)!==JSON.stringify(expected.map(p=>'package/'+p).sort())) throw new Error('unexpected package members')
const extracted=join(dest,'extracted');mkdirSync(extracted)
execFileSync('tar.exe',['-xzf',tgz,'-C',extracted])
const files=expected.map(name=>{
 const actual=readFileSync(join(extracted,'package',name)), source=readFileSync(join(repo,name))
 if(!actual.equals(source)) throw new Error('tarball/source byte mismatch: '+name)
 return {path:name,bytes:actual.length,sha256:sha(actual)}
})
const pkg=JSON.parse(readFileSync(join(extracted,'package/package.json'),'utf8'))
if(pkg.version!=='0.2.2'||pkg.name!=='dsh-word-lookup') throw new Error('identity mismatch')
const originalLock=JSON.parse(readFileSync('E:/Projects/DSHarness/dsh-word-lookup/package-lock.json','utf8'))
const newLock=JSON.parse(readFileSync(join(repo,'package-lock.json'),'utf8'))
originalLock.version='0.2.2';originalLock.packages[''].version='0.2.2'
if(JSON.stringify(originalLock)!==JSON.stringify(newLock)) throw new Error('lock dependency drift')
const dbPath=join(dest,'owned-candidate.sqlite3'), db=new DatabaseSync(dbPath)
db.exec("CREATE TABLE entries(word TEXT PRIMARY KEY COLLATE NOCASE,translation TEXT); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO entries VALUES('verify','验证'); INSERT INTO meta VALUES('entry_count','1');")
db.close()
const requestId=randomUUID(), worker=new Worker(pathToFileURL(join(extracted,'package/lib/ecdict-integrity-worker.js')),{workerData:{requestId,candidatePath:dbPath}})
let response
await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{worker.terminate().then(()=>reject(new Error('owned Worker timeout')),reject)},10000)
 worker.on('error',e=>{clearTimeout(timer);reject(e)})
 worker.on('message',value=>{response=value})
 worker.on('exit',code=>{clearTimeout(timer); if(code!==0) reject(new Error('Worker exit '+code));else resolve()})
})
if(response?.requestId!==requestId||response?.success!==true||response?.integrityResult!=='ok') throw new Error('integrity verification failed')
await unlink(dbPath)
if(existsSync(dbPath)) throw new Error('database handle not released')
const report={version:pkg.version,tarball:tgz,bytes:bytes.length,sha256:sha(bytes),integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),members:files,dependencyLock:'UNCHANGED_EXCEPT_ROOT_VERSION',worker:{response,exitCode:0,deleteAfterExit:'PASS'}}
writeFileSync(join(root,'evidence',reportName),JSON.stringify(report,null,2))
console.log(JSON.stringify({version:report.version,bytes:report.bytes,sha256:report.sha256,members:files.length,worker:report.worker,lock:report.dependencyLock},null,2))
