import {spawn,spawnSync,execFileSync} from 'node:child_process'
import {readFileSync,writeFileSync,mkdirSync,realpathSync,existsSync,readdirSync} from 'node:fs'
import {join,resolve,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
const root=fileURLToPath(new URL('.',import.meta.url)),repo=join(root,'repo')
const {chromium}=createRequire(join(repo,'package.json'))('playwright')
const {assertIsolatedDshEnvironment,buildIsolatedEnv,isPortFree,isInsideOrEqual}=await import('./repo/scripts/assert-isolated-env.mjs')
const {createOwnedTestRoot,createOwnedHome}=await import('./repo/scripts/isolated-run-directory.mjs')
const {bootReleaseDsh,cleanupReleaseSmokeResources,collectUninstallProof,probeUninstallPage}=await import('./repo/scripts/probes/release-v0.2.1/release-smoke.mjs')
const {formattingObservations,scrollObservation,evaluateSmokeVerdict}=await import('./repo/scripts/smoke-verdict.mjs')
const {evaluateNetworkWindow}=await import('./network-verdict.mjs')
const {redactTokens,redactTokenText}=await import('./repo/scripts/redact.mjs')
const hash=b=>createHash('sha256').update(b).digest('hex')
const required=['actual-version','new-profile-created','installed-package-isolation','installed-payload-exact','plugin-loaded','fixture-active','real-fixture-lookup','settings-visible','auto-gestures-default-off','literal-escaping','line-count','vertical-layout','pos','formatting-measured','narrow-viewport','scrollability','scroll-measured','uninstall-service-healthy-and-plugin-absent','network-full-window-coverage','zero-auto-download','no-browser-pageerror']
required.push('native-default-shortcut')
const runId=randomUUID().slice(0,8),testRoot=join(root,'runtime022-'+runId),home=join(testRoot,'home'),profile='release022-rc3-'+runId
const evidenceDir=join(root,'evidence','runtime022-'+runId);mkdirSync(evidenceDir)
const networkDir=join(evidenceDir,'network');mkdirSync(networkDir)
for(const [name,from] of [['runtime-harness.mjs',fileURLToPath(import.meta.url)],['network-observer.cjs',join(root,'network-observer.cjs')],['network-verdict.mjs',join(root,'network-verdict.mjs')]])writeFileSync(join(evidenceDir,name),readFileSync(from))
const protectedEnv={...process.env,DSH_HOME:'C:/Users/20659/.dsh'}
let port=54510;while(!await isPortFree(port))port++
const verified=assertIsolatedDshEnvironment({testRoot,home,profile,port,env:protectedEnv})
const owner=await createOwnedTestRoot({requestedRoot:testRoot,env:protectedEnv});await createOwnedHome(owner,home)
const cmd='E:/Laptop/softwares/DSH/DeepSeek Harness.exe',cli='E:/Laptop/softwares/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
const baseArgs=['--expose-internals',cli],observer=join(root,'network-observer.cjs')
const env=buildIsolatedEnv(verified,process.env,{ELECTRON_RUN_AS_NODE:'1',DSH_AGENTS_HOME:join(testRoot,'agents'),npm_config_offline:'true',npm_config_store_dir:join(testRoot,'pnpm-store'),COREPACK_ENABLE_NETWORK:'0'})
for(const key of Object.keys(env))if(/TOKEN|SECRET|CREDENTIAL|PASSWORD|API[_-]?KEY|AUTH/i.test(key))delete env[key]
delete env.NODE_OPTIONS
const candidate=process.argv[2]?resolve(process.argv[2]):join(root,'candidate-final/dsh-word-lookup-0.2.2.tgz')
const report={runId,requestedBaseline:'Current installed DSH (user described RC 1.3)',actualBaseline:'NOT_VERIFIED',status:'INCOMPLETE',startedAt:new Date().toISOString(),isolation:{testRoot,home,profile,port},candidate:{path:candidate,sha256:hash(readFileSync(candidate))},observations:[],boots:[],classification:{fixture:'REAL_HOST_SQLITE',formatting:'CONTROLLED_RESPONSE',realEcdict:'NOT_EXECUTED',desktop:'NOT_EXECUTED'},network:{mode:'Observe and block every non-loopback attempt through instrumented Node APIs and browser',status:'NOT_VERIFIED'},cleanup:{status:'PENDING'}}
report.harnessSha256=hash(readFileSync(fileURLToPath(import.meta.url)));report.observerSha256=hash(readFileSync(observer))
const check=(id,ok,details)=>{report.observations.push({id,status:ok?'PASS':'FAIL',...(details===undefined?{}:{details})});if(!ok)throw new Error('acceptance failed: '+id)}
function command(label,args){const result=spawnSync(cmd,[...baseArgs,...args],{cwd:testRoot,env,windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024});writeFileSync(join(evidenceDir,label+'.txt'),redactTokenText(result.stdout+result.stderr));if(result.status!==0)throw new Error(label+' exit '+result.status+': '+redactTokenText(result.stderr).slice(-1200));return result.stdout}
let context,instance,page,firstOrigin;const browserRequests=[],externalBrowser=[],pageErrors=[]
let phase='setup';report.pageErrorDetails=[]
async function openBrowser(label){
 phase=label
 context=await chromium.launchPersistentContext(join(testRoot,'browser-'+label),{headless:true,viewport:{width:1280,height:800},executablePath:'C:/Users/20659/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'})
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(!['http:','https:'].includes(u.protocol))return route.continue();const row={time:Date.now(),phase,origin:u.origin,path:u.pathname,method:route.request().method()};browserRequests.push(row);if(u.origin!==firstOrigin){externalBrowser.push(row);return route.abort()};return route.continue()})
 page=context.pages()[0]??await context.newPage();page.on('pageerror',error=>{pageErrors.push(String(error.message));report.pageErrorDetails.push({phase,time:Date.now(),message:error.message,stack:redactTokenText(error.stack??'')})})
}
async function stop(){if(!instance)return;const item=instance,boot=report.boots.find(x=>x.pid===item.child.pid);boot.wasRunningAtShutdown=item.child.exitCode===null&&item.child.signalCode===null;boot.terminationReason='OWNED_TEST_SHUTDOWN';await cleanupReleaseSmokeResources({context:null,dshInstance:item,testPort:port});boot.exitedAt=Date.now();boot.exitCode=item.child.exitCode;boot.signalCode=item.child.signalCode;boot.portFree=await isPortFree(port);writeFileSync(join(evidenceDir,'boot-'+item.child.pid+'.txt'),redactTokenText(item.stdoutLog()+item.stderrLog()));instance=null;if(!boot.wasRunningAtShutdown)throw new Error('DSH exited before requested test shutdown')}
async function start(){const bootEnv={...env,WL_AUDIT_RUN_ID:runId,WL_AUDIT_NETWORK_DIR:networkDir};instance=await bootReleaseDsh(verified,port,testRoot,{cmd,baseArgs:['--expose-internals','--require',observer,cli],isNodeScript:true},90000,{env:bootEnv,spawnChild:(cmd,args,opts)=>spawn(cmd,args,{...opts,windowsHide:true})});report.boots.push({pid:instance.child.pid,startedAt:Date.now(),origin:new URL(instance.url).origin});return instance}
try{
 const version=command('version',['--version']).trim();report.actualBaseline=version;check('actual-version',version==='0.2.1-rc.3',{version,nodeCarrier:'24.21.0',invocation:{cmd,baseArgs}})
 command('profile-create',['--profile',profile,'--from-default-profile','web','--dump-config']);check('new-profile-created',existsSync(join(verified.profileDir,'package.json')))
 mkdirSync(join(testRoot,'documents'))
 writeFileSync(join(verified.profileDir,'cordis.patch.yml'),['- id: webserver','  config:',"    host: !!js ctx.webStartup.host ?? '127.0.0.1'",`    port: !!js ctx.webStartup.port ?? ${port}`,'- id: workspace-controller','  config:',`    documentsDirectory: ${JSON.stringify(join(testRoot,'documents'))}`,''].join('\n'))
 command('install',['plugin','--profile',profile,'add',candidate,'--offline','--ignore-scripts','--store-dir',join(testRoot,'pnpm-store')])
 const installed=join(verified.profileDir,'node_modules/dsh-word-lookup'),canonical=realpathSync(installed)
 check('installed-package-isolation',isInsideOrEqual(canonical,verified.profileDir)&&!isInsideOrEqual(canonical,'E:/Projects/DSHarness/dsh-word-lookup'),{canonical})
 const members=['LICENSE','README.md','cordis.patch.yml','corpus/ecdict.manifest.json','lib/client.js','lib/ecdict-integrity-worker.js','lib/index.js','package.json']
 report.installedMembers=members.map(name=>({path:name,sha256:hash(readFileSync(join(installed,name)))}))
 check('installed-payload-exact',members.every(name=>readFileSync(join(installed,name)).equals(readFileSync(join(repo,name)))))
 await start();firstOrigin=new URL(instance.url).origin
 await openBrowser('installed')
 await page.goto(instance.url,{waitUntil:'networkidle',timeout:30000})
 await page.waitForFunction(()=>typeof window.__DSH_WORD_LOOKUP__==='object',null,{timeout:15000});check('plugin-loaded',true)
 await page.waitForTimeout(600)
 for(let i=0;i<6;i++){const dialog=page.getByRole('dialog').last();if(!await dialog.isVisible().catch(()=>false))break;const b=dialog.getByRole('button',{name:/^(Continue|Got it|Not now|Skip|Configure later|Close|继续|稍后配置|跳过|关闭)$/i}).last();if(await b.isVisible().catch(()=>false)){await b.click();await page.waitForTimeout(600)}else break}
 await page.screenshot({path:join(evidenceDir,'01-startup.png'),fullPage:true})
 const fixture=await page.evaluate(async()=>{const status=await(await fetch('api/dsh-word-lookup/dictionary/status')).json();const word=await(await fetch('api/dsh-word-lookup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'derive'})})).json();return {status,word}})
 report.fixture=fixture;check('fixture-active',fixture.status.activeMode==='fixture'&&fixture.status.installed===false);check('real-fixture-lookup',fixture.word.found===true&&fixture.word.headword==='derive'&&fixture.word.source==='sqlite-fixture')
 const issuedBefore=await page.evaluate(()=>{const span=document.createElement('span');span.id='audit-native-selected-word';span.setAttribute('data-chat-flow-kind','assistant-step');span.setAttribute('data-chat-node-key','audit-controlled-flow');span.textContent='derive';span.tabIndex=-1;span.style.cssText='position:fixed;left:400px;top:90px;z-index:2;background:white;color:black';document.body.appendChild(span);span.focus();const range=document.createRange();range.selectNodeContents(span);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return window.__DSH_WORD_LOOKUP__.lookups()})
 const nativeResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/dsh-word-lookup'&&response.request().method()==='POST'&&response.request().postDataJSON()?.query==='derive',{timeout:10000}).then(value=>({value}),error=>({error}))
 await page.keyboard.press('Control+Shift+L');const observedNative=await nativeResponse;if(observedNative.error)throw observedNative.error
 const nativeBody=await observedNative.value.json(),issuedAfter=await page.evaluate(()=>window.__DSH_WORD_LOOKUP__.lookups())
 check('native-default-shortcut',observedNative.value.status()===200&&nativeBody.found===true&&nativeBody.headword==='derive'&&nativeBody.source==='sqlite-fixture'&&issuedAfter===issuedBefore+1,{issuedBefore,issuedAfter,response:nativeBody,selection:'Controlled conversation DOM with the documented data-chat-flow-kind marker; actual registered shortcut and real Host'})
 report.classification.nativeShortcut='REAL_KEYBOARD_REAL_HOST_SQLITE'
 await page.waitForSelector('[data-dsh-word-lookup="card"]');await page.screenshot({path:join(evidenceDir,'07-native-shortcut.png'),fullPage:true})
 await page.evaluate(()=>{window.__DSH_WORD_LOOKUP__.dismiss();getSelection().removeAllRanges();document.getElementById('audit-native-selected-word').remove()})
 await page.getByRole('button',{name:/^(Account menu|账户菜单)$/i}).click()
 await page.getByRole('menuitem',{name:/Settings|设置/i}).click()
 const nav=page.locator('nav button').filter({hasText:/词典|Dictionary/i}).first();await nav.waitFor({state:'visible',timeout:10000});await nav.click()
 await page.locator('.dsh-wl-settings').waitFor({state:'visible',timeout:10000});check('settings-visible',true)
 const gates=await page.evaluate(()=>window.__DSH_WORD_LOOKUP__.gates());check('auto-gestures-default-off',gates.autoDoubleClick===false&&gates.autoSelection===false,gates)
 await page.screenshot({path:join(evidenceDir,'02-settings.png'),fullPage:true});await page.keyboard.press('Escape');await page.waitForTimeout(300)
 await page.route('**/api/dsh-word-lookup',async route=>{
  const body=route.request().postDataJSON();if(!['pass','long-entry'].includes(body?.query))return route.continue()
  const long=body.query==='long-entry',payload={ok:true,found:true,query:body.query,headword:body.query,phonetic:'/test/',meanings:[{partOfSpeech:long?'n.':'v.',translation:long?Array.from({length:12},(_,i)=>`n. 释义行 ${i+1}：验证长释义卡片垂直滚动的详细中文翻译和上下文`).join('\\n'):'n. 通行证\\nvt. 通过\\nvi. 经过',definition:long?Array.from({length:12},(_,i)=>`Definition ${i+1}: long synthetic explanation for actual card overflow verification`).join('\\n'):'n. a pass\\nn. a success\\nv. to move\\nv. to give'}],forms:[],matchedForm:null,examples:[],source:'ecdict-local',settings:{autoDoubleClick:false,autoSelection:false}}
  return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)})
 })
 await page.evaluate(()=>window.__DSH_WORD_LOOKUP__.runLookup('pass','shortcut'));await page.waitForSelector('[data-dsh-word-lookup="translation-line"]')
 const metrics=await page.evaluate(()=>{const trans=[...document.querySelectorAll('[data-dsh-word-lookup="translation-line"]')],defs=[...document.querySelectorAll('[data-dsh-word-lookup="definition-line"]')],card=document.querySelector('[data-dsh-word-lookup="card"]');return{hasLiteralEscapeInText:card.textContent.includes('\\n'),transLineCount:trans.length,defLineCount:defs.length,transRects:trans.map(el=>({top:el.getBoundingClientRect().top})),defRects:defs.map(el=>({top:el.getBoundingClientRect().top})),hasDuplicatePos:(trans[0]?.textContent??'').includes('v.n.'),firstTransLine:trans[0]?.textContent.trim()??''}})
 report.observations.push(...formattingObservations(metrics));check('formatting-measured',formattingObservations(metrics).every(x=>x.status==='PASS'),metrics)
 await page.screenshot({path:join(evidenceDir,'03-card.png'),fullPage:true})
 await page.setViewportSize({width:320,height:800});await page.waitForTimeout(300)
 const width=await page.locator('[data-dsh-word-lookup="card"]').evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width}));check('narrow-viewport',width.left>=0&&width.right<=321&&width.width<=320,width)
 await page.screenshot({path:join(evidenceDir,'04-narrow.png'),fullPage:true})
 await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>window.__DSH_WORD_LOOKUP__.dismiss());await page.evaluate(()=>window.__DSH_WORD_LOOKUP__.runLookup('long-entry','shortcut'));await page.waitForTimeout(500)
 const scrolling=await page.locator('[data-dsh-word-lookup="card"]').evaluate(async el=>{const beforeScroll=el.scrollTop;el.scrollTop=120;await new Promise(r=>requestAnimationFrame(r));return{beforeScroll,afterScroll:el.scrollTop,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth}})
 const scroll=scrollObservation(scrolling,'scrollability');report.observations.push(scroll);check('scroll-measured',scroll.status==='PASS')
 await page.screenshot({path:join(evidenceDir,'05-scroll.png'),fullPage:true});await page.waitForTimeout(1500)
 await context.close();context=null;page=null;phase='owned-shutdown-before-uninstall'
 await stop();command('uninstall',['plugin','--profile',profile,'remove','dsh-word-lookup','--store-dir',join(testRoot,'pnpm-store')]);await start();await openBrowser('uninstalled')
 await page.unroute('**/api/dsh-word-lookup');await page.goto(instance.url,{waitUntil:'networkidle',timeout:30000})
 const connectionHash='0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684',contract='dsh-client-connection@0.2.1-rc.3:'+connectionHash+':404'
 const proof=await collectUninstallProof({probe:rpcId=>probeUninstallPage(page,rpcId),anonymousProbe:async()=>{try{const res=await fetch(firstOrigin+'/api/pluginInventory/list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:'pluginInventory/list',payload:{args:{}}})});return{kind:'response',status:res.status}}catch{return{kind:'transport-error'}}},service:{origin:firstOrigin,identified:instance.child.exitCode===null&&new URL(firstOrigin).hostname==='127.0.0.1'&&Number(new URL(firstOrigin).port)===port},routeContract:{contract}})
 report.uninstallProof=proof
 check('uninstall-service-healthy-and-plugin-absent',proof.route.kind==='response'&&proof.route.status===404&&proof.base.kind==='response'&&proof.base.status===200&&proof.base.authenticated&&proof.base.identified&&proof.registration.kind==='inventory'&&proof.registration.absent&&proof.routeMissingContract===contract)
 await page.screenshot({path:join(evidenceDir,'06-uninstalled.png'),fullPage:true});await page.waitForTimeout(1000);await context.close();context=null;await stop()
 const records=readdirSync(networkDir).flatMap(name=>readFileSync(join(networkDir,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse))
 const mainReady=records.filter(x=>x.kind==='observer-ready'&&x.threadId===0),external=records.filter(x=>x.external),unknown=records.filter(x=>x.unknown),opaqueChildren=records.filter(x=>x.kind==='child-created'),workers=records.filter(x=>x.kind==='worker-created')
 report.network={...report.network,records:records.length,mainReadyPids:mainReady.map(x=>x.pid),externalAttempts:external,browserExternalAttempts:externalBrowser,unknownTargets:unknown,children:opaqueChildren,workers,browserRequestCount:browserRequests.length,fullWindowBoots:report.boots}
 const networkVerdict=evaluateNetworkWindow({boots:report.boots,records,browserExternal:externalBrowser,observerSha256:report.observerSha256,connectionSha256:connectionHash})
 check('network-full-window-coverage',networkVerdict==='PASS',{networkVerdict})
 check('zero-auto-download',external.length===0&&externalBrowser.length===0);report.network.status='PASS'
 check('no-browser-pageerror',pageErrors.length===0,pageErrors);report.status=evaluateSmokeVerdict(report.observations,required)
}catch(error){report.error={name:error.name,message:redactTokenText(String(error.message))};report.status='FAIL';console.error(report.error.message);if(page){await page.screenshot({path:join(evidenceDir,'failure.png'),fullPage:true}).catch(()=>{});report.visibleUi=await page.evaluate(()=>({buttons:[...document.querySelectorAll('button')].map(x=>({text:x.innerText,label:x.getAttribute('aria-label')})),navs:[...document.querySelectorAll('nav')].map(x=>x.innerText),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(x=>x.innerText)})).catch(()=>null)}}
finally{
 try{if(context)await context.close()}catch(e){report.browserCleanupError=redactTokenText(e.message);report.status='FAIL'}
 try{await stop();report.cleanup={status:report.browserCleanupError?'FAIL':'PASS',testRoot:'RETAINED',portFree:await isPortFree(port)}}catch(e){report.cleanup={status:'FAIL',message:redactTokenText(e.message),testRoot:'RETAINED'};report.status='FAIL'}
 report.endedAt=new Date().toISOString();report.browserRequests=browserRequests;report.pageErrors=pageErrors
 writeFileSync(join(evidenceDir,'runtime-report.json'),JSON.stringify(redactTokens(report),null,2));writeFileSync(join(root,'runtime-last-report-path.txt'),join(evidenceDir,'runtime-report.json'))
 console.log(JSON.stringify({status:report.status,baseline:report.actualBaseline,report:join(evidenceDir,'runtime-report.json'),observations:report.observations.map(x=>({id:x.id,status:x.status})),error:report.error,cleanup:report.cleanup},null,2))
}
process.exitCode=report.status==='PASS'?0:1
