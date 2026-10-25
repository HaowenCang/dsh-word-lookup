import assert from 'node:assert/strict'
import {evaluateNetworkWindow} from './network-verdict.mjs'
const make=()=>({boots:[{pid:1,exitedAt:50,portFree:true,exitCode:1,wasRunningAtShutdown:true},{pid:2,exitedAt:60,portFree:true,exitCode:1,wasRunningAtShutdown:true}],records:[1,2].map(pid=>({pid,kind:'observer-ready',threadId:0,sequence:1,observerSha256:'observer',connectionSha256:'connection'})),browserExternal:[],observerSha256:'observer',connectionSha256:'connection'})
assert.equal(evaluateNetworkWindow(make()),'PASS')
for(const mutate of [x=>x.records.pop(),x=>x.records.push({...x.records[0]}),x=>x.boots[0].exitCode=null,x=>x.boots[0].portFree=false,x=>x.records[0].observerSha256='other',x=>x.records[1].connectionSha256='other',x=>x.records.push({kind:'worker-created'}),x=>x.records.push({kind:'child-created',networkCapability:'UNKNOWN'}),x=>x.records.push({unknown:true})]){const value=make();mutate(value);assert.equal(evaluateNetworkWindow(value),'INCOMPLETE')}
for(const mutate of [x=>x.records.push({external:true}),x=>x.browserExternal.push({origin:'https://example.invalid'})]){const value=make();mutate(value);assert.equal(evaluateNetworkWindow(value),'FAIL')}
const local=make();local.records.push({pid:1,threadId:0,sequence:2,kind:'child-created',networkCapability:'LOCAL_REGISTRY_READ_ONLY'});assert.equal(evaluateNetworkWindow(local),'PASS')
const died=make();died.boots[0].wasRunningAtShutdown=false
const gap=make();gap.records.push({pid:1,threadId:0,sequence:3,kind:'http-request'})
console.log('negative controls:',JSON.stringify({prematureDeath:evaluateNetworkWindow(died),missingRecord:evaluateNetworkWindow(gap)}))
assert.equal(evaluateNetworkWindow(died),'INCOMPLETE','premature process death must not pass')
assert.equal(evaluateNetworkWindow(gap),'INCOMPLETE','a missing sequence record must not pass')
console.log('network-verdict: 15 cases PASS')
