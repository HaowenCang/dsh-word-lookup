// Preloaded only into this audit's owned Node/Electron children. Never used by production DSH.
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const tls = require('node:tls')
const http = require('node:http')
const https = require('node:https')
const dc = require('node:diagnostics_channel')
const threads = require('node:worker_threads')
const cp = require('node:child_process')
const crypto = require('node:crypto')
const { syncBuiltinESMExports } = require('node:module')
const logDir = process.env.WL_AUDIT_NETWORK_DIR
const runId = process.env.WL_AUDIT_RUN_ID
if (!logDir || !path.isAbsolute(logDir) || !runId) throw new Error('audit network observer requires an explicit log directory and run identity')
const target = path.join(logDir, `network-${runId}-${process.pid}-${threads.threadId}.jsonl`)
const local = host => ['localhost','127.0.0.1','::1','[::1]'].includes(String(host).toLowerCase())
let sequence = 0
const record = (kind, data = {}) => fs.appendFileSync(target, JSON.stringify({runId,pid:process.pid,threadId:threads.threadId,sequence:++sequence,time:Date.now(),kind,...data})+'\n')
function endpoint(value) {
  try { const u = new URL(typeof value === 'string' || value instanceof URL ? value : value.url); return {protocol:u.protocol,host:u.hostname,port:u.port,path:u.pathname} }
  catch { return {unknown:true} }
}
function guard(kind, value) {
  const fields = value
  const external = Boolean(fields.host && !local(fields.host))
  record(kind,{...fields,external,blocked:external})
  if (external) throw Object.assign(new Error('audit blocked external network attempt'),{code:'AUDIT_EXTERNAL_NETWORK_BLOCKED'})
}
const originalFetch = globalThis.fetch
globalThis.fetch = function(...args) {
  try { guard('fetch',endpoint(args[0])) }
  catch (error) { return Promise.reject(error) }
  return Reflect.apply(originalFetch,this,args)
}
function socketEndpoint(args) {
  if (Array.isArray(args[0])) args=args[0]
  const first=args[0]
  if (first && typeof first==='object') return first.path ? {pipe:true} : {host:first.host??first.hostname??'localhost',port:String(first.port??'')}
  if (typeof first==='string' && !/^\d+$/.test(first)) return {pipe:true}
  return {host:typeof args[1]==='string'?args[1]:'localhost',port:String(first??'')}
}
const originalConnect=net.Socket.prototype.connect
net.Socket.prototype.connect=function(...args){guard('socket-connect',socketEndpoint(args));return Reflect.apply(originalConnect,this,args)}
const originalTls=tls.connect
tls.connect=function(...args){guard('tls-connect',socketEndpoint(args));return Reflect.apply(originalTls,this,args)}
for(const module of [http,https]) for(const key of ['request','get']) {
 const original=module[key]
 module[key]=function(...args){
  const first=args[0]
  const target=typeof first==='string'||first instanceof URL?endpoint(first):{host:first?.hostname??first?.host??'localhost',port:String(first?.port??''),path:String(first?.path??'/').split('?')[0]}
  guard('http-'+key,target)
  return Reflect.apply(original,this,args)
 }
}
dc.channel('undici:request:create').subscribe(({request})=>record('undici-request',{...endpoint(request.origin),path:String(request.path??'/').split('?')[0]}))
const OriginalWorker=threads.Worker
threads.Worker=class AuditObservedWorker extends OriginalWorker {
 constructor(filename,options){
  super(filename,options)
  record('worker-created',{workerThreadId:this.threadId,entry:path.basename(String(filename)),inheritsObserver:options?.execArgv===undefined||options.execArgv.includes('--require')})
 }
}
for(const key of ['spawn','execFile','exec','fork']) {
 const original=cp[key]
 cp[key]=function(...args){
  const child=Reflect.apply(original,this,args),command=path.basename(String(args[0])),argv=Array.isArray(args[1])?args[1].map(String):[]
  const localRegistry=command.toLowerCase()==='reg.exe'&&argv.length===3&&argv[0].toLowerCase()==='query'&&argv[2].toLowerCase()==='/s'&&/^(?:HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)\\SOFTWARE\\(?:WOW6432Node\\)?Microsoft\\Windows\\CurrentVersion\\(?:App Paths|Uninstall)$/i.test(argv[1])
  record('child-created',{operation:key,command,childPid:child.pid??null,argumentSha256:crypto.createHash('sha256').update(JSON.stringify(argv)).digest('hex'),networkCapability:localRegistry?'LOCAL_REGISTRY_READ_ONLY':'UNKNOWN',...(localRegistry?{registryQuery:argv}:{})})
  return child
 }
}
syncBuiltinESMExports()
const connectionFile='E:/Laptop/softwares/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js'
record('observer-ready',{node:process.version,isMainThread:threads.isMainThread,hooks:['fetch','http','https','socket','tls','undici','worker','child'],mode:'record-and-block-external',observerSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),connectionSha256:fs.existsSync(connectionFile)?crypto.createHash('sha256').update(fs.readFileSync(connectionFile)).digest('hex'):null})
process.once('exit',code=>record('observer-exit',{code}))
