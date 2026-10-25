export function evaluateNetworkWindow({boots,records,browserExternal,observerSha256,connectionSha256}) {
 if(!Array.isArray(boots)||boots.length!==2||!Array.isArray(records)||!Array.isArray(browserExternal)||!observerSha256||!connectionSha256)return 'INCOMPLETE'
 if(records.some(row=>row.external)||browserExternal.length)return 'FAIL'
 if(records.some(row=>row.unknown||row.kind==='worker-created'||(row.kind==='child-created'&&row.networkCapability!=='LOCAL_REGISTRY_READ_ONLY')))return 'INCOMPLETE'
 for(const boot of boots){
  const ready=records.filter(row=>row.kind==='observer-ready'&&row.threadId===0&&row.pid===boot.pid)
  if(ready.length!==1||ready[0].sequence!==1||ready[0].observerSha256!==observerSha256||ready[0].connectionSha256!==connectionSha256||boot.wasRunningAtShutdown!==true||!boot.exitedAt||!boot.portFree||(!Number.isInteger(boot.exitCode)&&!boot.signalCode))return 'INCOMPLETE'
  const window=records.filter(row=>row.pid===boot.pid)
  if(window.some((row,index)=>row.threadId!==0||row.sequence!==index+1))return 'INCOMPLETE'
 }
 if(records.some(row=>!boots.some(boot=>boot.pid===row.pid)))return 'INCOMPLETE'
 return 'PASS'
}
