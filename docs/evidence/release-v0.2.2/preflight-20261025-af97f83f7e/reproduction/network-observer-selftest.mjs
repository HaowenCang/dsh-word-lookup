import { createServer } from 'node:http'
import http from 'node:http'
import { readFileSync,readdirSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
const server=createServer((req,res)=>res.end('synthetic observer control'))
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const port=server.address().port
await fetch(`http://127.0.0.1:${port}/owned-control`)
await new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${port}/http-control`,res=>{res.resume();res.on('end',resolve)}).on('error',reject))
await fetch('https://audit-network-block-control.invalid/').then(()=>{throw new Error('external guard did not reject')},e=>{if(e.code!=='AUDIT_EXTERNAL_NETWORK_BLOCKED')throw e})
await new Promise(resolve=>server.close(resolve))
const rows=readdirSync(process.env.WL_AUDIT_NETWORK_DIR).filter(x=>x.startsWith('network-'+process.env.WL_AUDIT_RUN_ID+'-')).flatMap(name=>readFileSync(join(process.env.WL_AUDIT_NETWORK_DIR,name),'utf8').trim().split('\n').map(JSON.parse))
for(const kind of ['observer-ready','fetch','http-get','socket-connect','undici-request'])if(!rows.some(x=>x.kind===kind))throw new Error('missing positive control '+kind)
if(rows.filter(x=>x.external).length!==1||!rows.find(x=>x.external).blocked)throw new Error('external guard coverage failed')
console.log(JSON.stringify({status:'PASS',records:rows.length,positiveControls:['fetch','http','socket','undici'],externalControl:'blocked before transport'}))
