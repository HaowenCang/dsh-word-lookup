import {spawn,spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
const root=fileURLToPath(new URL('.',import.meta.url)),repo=join(root,'repo'),runId='control-'+randomUUID().slice(0,8),testRoot=join(root,runId),home=join(testRoot,'home'),profile='release022-'+runId
const evidenceDir=join(root,'evidence',runId),network=join(evidenceDir,'network');mkdirSync(evidenceDir);mkdirSync(network)
const {chromium}=createRequire(join(repo,'package.json'))('playwright')
const {assertIsolatedDshEnvironment,buildIsolatedEnv,isPortFree}=await import('./repo/scripts/assert-isolated-env.mjs')
const {createOwnedTestRoot,createOwnedHome}=await import('./repo/scripts/isolated-run-directory.mjs')
const {bootReleaseDsh,cleanupReleaseSmokeResources}=await import('./repo/scripts/probes/release-v0.2.1/release-smoke.mjs')
const {redactTokens,redactTokenText}=await import('./repo/scripts/redact.mjs')
let port=54620;while(!await isPortFree(port))port++
const protectedEnv={...process.env,DSH_HOME:'C:/Users/20659/.dsh'},verified=assertIsolatedDshEnvironment({testRoot,home,profile,port,env:protectedEnv})
const owner=await createOwnedTestRoot({requestedRoot:testRoot,env:protectedEnv});await createOwnedHome(owner,home);mkdirSync(join(testRoot,'documents'))
const env=buildIsolatedEnv(verified,process.env,{ELECTRON_RUN_AS_NODE:'1',DSH_AGENTS_HOME:join(testRoot,'agents'),WL_AUDIT_RUN_ID:runId,WL_AUDIT_NETWORK_DIR:network})
for(const key of Object.keys(env))if(/TOKEN|SECRET|CREDENTIAL|PASSWORD|API[_-]?KEY|AUTH/i.test(key))delete env[key];delete env.NODE_OPTIONS
const cmd='E:/Laptop/softwares/DSH/DeepSeek Harness.exe',cli='E:/Laptop/softwares/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js',baseArgs=['--expose-internals',cli]
const init=spawnSync(cmd,[...baseArgs,'--profile',profile,'--from-default-profile','web','--dump-config'],{cwd:testRoot,env,encoding:'utf8',windowsHide:true});if(init.status!==0)throw new Error('control init failed')
writeFileSync(join(verified.profileDir,'cordis.patch.yml'),['- id: webserver','  config:',"    host: !!js ctx.webStartup.host ?? '127.0.0.1'",`    port: !!js ctx.webStartup.port ?? ${port}`,'- id: workspace-controller','  config:',`    documentsDirectory: ${JSON.stringify(join(testRoot,'documents'))}`,''].join('\n'))
const pkg=JSON.parse(readFileSync(join(verified.profileDir,'package.json'),'utf8'));if(Object.keys(pkg.dependencies??{}).length!==0)throw new Error('control must have no external plugins')
const report={runId,profile,testRoot,pluginInstalled:false,events:[],boots:[],errors:[],status:'INCOMPLETE'}
let phase='setup',instance,context,page
const start=async()=>{instance=await bootReleaseDsh(verified,port,testRoot,{cmd,baseArgs:['--expose-internals','--require',join(root,'network-observer.cjs'),cli],isNodeScript:true},90000,{env,spawnChild:(cmd,args,options)=>spawn(cmd,args,{...options,windowsHide:true})});report.boots.push(instance.child.pid)}
const stop=async()=>{if(instance){await cleanupReleaseSmokeResources({context:null,dshInstance:instance,testPort:port});instance=null}}
try{
 await start();context=await chromium.launchPersistentContext(join(testRoot,'browser'),{headless:true,executablePath:'C:/Users/20659/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'})
 const origin=new URL(instance.url).origin
 await context.route('**/*',route=>{const u=new URL(route.request().url());return ['http:','https:'].includes(u.protocol)&&u.origin!==origin?route.abort():route.continue()})
 page=context.pages()[0]??await context.newPage();page.on('pageerror',error=>report.errors.push({phase,time:Date.now(),message:error.message,stack:redactTokenText(error.stack??'')}))
 phase='first-load-without-plugin';await page.goto(instance.url,{waitUntil:'networkidle'});await page.waitForTimeout(1200)
 report.firstAbsence=await page.evaluate(async()=>({globalAbsent:typeof window.__DSH_WORD_LOOKUP__==='undefined',status:(await fetch('api/dsh-word-lookup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'derive'})})).status}))
 for(let i=0;i<2;i++){
  phase='intentional-disconnect-'+i;await stop();await page.waitForTimeout(700)
  phase='reconnect-without-plugin-'+i;await start();await page.waitForTimeout(1000);await page.goto(instance.url,{waitUntil:'networkidle'});await page.waitForTimeout(1000)
 }
 report.lastGlobalAbsent=await page.evaluate(()=>typeof window.__DSH_WORD_LOOKUP__==='undefined')
 report.status=report.errors.some(e=>e.message.includes("scope 'session-maybe' rendered without an installed adapter"))?'UPSTREAM_REPRODUCED_WITHOUT_PLUGIN':'NOT_REPRODUCIBLE_IN_CONTROL'
}catch(e){report.status='CONTROL_ERROR';report.error=redactTokenText(e.message)}finally{
 if(context)await context.close().catch(e=>{report.cleanupError=redactTokenText(e.message)})
 await stop();report.portFree=await isPortFree(port)
 writeFileSync(join(evidenceDir,'control-report.json'),JSON.stringify(redactTokens(report),null,2));console.log(JSON.stringify({status:report.status,errors:report.errors,report:join(evidenceDir,'control-report.json'),portFree:report.portFree},null,2))
}
