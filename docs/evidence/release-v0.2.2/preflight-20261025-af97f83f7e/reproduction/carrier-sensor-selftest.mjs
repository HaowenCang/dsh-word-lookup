import {spawnSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomUUID} from 'node:crypto'
const root=fileURLToPath(new URL('.',import.meta.url))
const controlId='carrier-control-'+randomUUID().slice(0,8)
const env={...process.env,ELECTRON_RUN_AS_NODE:'1',WL_AUDIT_NETWORK_DIR:join(root,'network-control'),WL_AUDIT_RUN_ID:controlId}
const result=spawnSync('E:/Laptop/softwares/DSH/DeepSeek Harness.exe',['--require',join(root,'network-observer.cjs'),join(root,'network-observer-selftest.mjs')],{env,cwd:root,windowsHide:true,encoding:'utf8'})
writeFileSync(join(root,'evidence',controlId+'.txt'),result.stdout+result.stderr+'\nEXIT_CODE='+result.status)
console.log(result.stdout+result.stderr);process.exitCode=result.status??1
