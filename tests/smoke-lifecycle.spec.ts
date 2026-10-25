import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixtures: string[] = []
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const maintenance = fileURLToPath(new URL('../scripts/maintenance-m1-browser-smoke.mjs', import.meta.url))
const release = fileURLToPath(new URL('../scripts/probes/release-v0.2.1/release-smoke.mjs', import.meta.url))

// Only the owned Node evidence subprocess is real. Children, browser, timers and
// shutdown are controlled; the startup and finalizer under test are production.
function scenario(runner: 'maintenance' | 'release', mode: string) {
  const root = mkdtempSync(join(tmpdir(), 'smoke-lifecycle-')); fixtures.push(root)
  const home = join(root, 'user'), temporary = join(root, 'tmp')
  mkdirSync(home); mkdirSync(temporary)
  const source = `
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { readFileSync, writeFileSync } from 'node:fs';
    import os from 'node:os'; import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const runner=${JSON.stringify(runner)},mode=${JSON.stringify(mode)};
    if(path.resolve(os.homedir())!==path.resolve(process.env.USERPROFILE)||path.resolve(os.tmpdir())!==path.resolve(process.env.TEMP)) throw Error('bad isolation');
    const module = await import(pathToFileURL(${JSON.stringify(runner === 'maintenance' ? maintenance : release)}));
    const run = runner==='maintenance' ? module.runMaintenanceSmoke : module.runReleaseSmoke;
    const child = Object.assign(new EventEmitter(), { stdout:new PassThrough(), stderr:new PassThrough(), exitCode:null, signalCode:null });
    const facts = { timers:0, cleared:0, stopAttempts:0, closeAttempts:0, removeAttempts:0, bootCalls:0 };
    let ownedHandle;
    const dependencies = {
      env:{}, delay:async()=>{},
      spawnChild:()=>{ queueMicrotask(()=>{
        if(mode==='timeout') return;
        if(mode==='early-exit') {child.exitCode=2;child.emit('exit',2);return;}
        if(['ready','late-error','reboot-ready','reboot-late-error'].includes(mode)) {
          child.stdout.write('http://127.0.0.1:50995/?token=SYNTHETIC_REDACTED');
          if(mode==='late-error') child.emit('error',Error('synthetic late child error'));
          if(mode==='reboot-late-error') child.emit('error',Error('synthetic late child error ?token=SYNTHETIC_SECRET'));
          return;
        }
        child.emit('error',Object.assign(Error('synthetic spawn failure'),{code:mode==='eacces'?'EACCES':mode==='unknown-error'?'EIO':'ENOENT'}));
      }); return child; },
      setTimer:(fn,ms)=>{facts.timers++; return setTimeout(fn,Math.min(ms,50));},
      clearTimer:(timer)=>{facts.cleared++;clearTimeout(timer);},
      stopChild:async()=>{facts.stopAttempts++; if(mode==='stop-error') throw Error('synthetic stop unconfirmed'); child.exitCode=0;},
    };
    const result = await run({
      execute:async(report)=>{
        if(!mode.startsWith('reboot-')) dependencies.onChildError=error=>report.observations.push({id:'runtime-child-error',status:'FAIL',message:error.message});
        if(['close-error','close-and-stop-error','primary-and-cleanup-error'].includes(mode)) {
          child.pid=99999;
          // This owned synthetic handle models piped-child activity. Only the
          // successful stop seam clears it, proving close-error can terminate.
          if(mode==='close-error') ownedHandle=setInterval(()=>{},25);
          await module.cleanupReleaseSmokeResources({
            context:{close:async()=>{facts.closeAttempts++; throw Error('synthetic browser close failure');}},
            dshInstance:{child},testPort:50995,downloadedTarballPath:'SYNTHETIC_NEVER_DELETE',
          },{
            stopChild:async()=>{facts.stopAttempts++; if(mode==='close-and-stop-error'||mode==='primary-and-cleanup-error') throw Error('synthetic stop unconfirmed');clearInterval(ownedHandle);child.exitCode=0;},
            exists:()=>true,removeTarball:()=>{facts.removeAttempts++;},
          },mode==='primary-and-cleanup-error'?Error('synthetic collection primary failure'):undefined);
        } else {
          if(['pid-present','stop-error','timeout','early-exit','ready','late-error','reboot-ready','reboot-late-error'].includes(mode)) child.pid=99999;
          if(runner==='maintenance') await module.startMaintenanceDsh(dependencies);
          else if(mode.startsWith('reboot-')) {
            // Execute the default collector's exact post-uninstall call, not a
            // rewritten call to its export. Only its startup dependencies are synthetic.
            const production = readFileSync(${JSON.stringify(release)},'utf8');
            const marker = production.indexOf("console.log('Rebooting isolated DSH without plugin");
            if(marker<0) throw Error('missing default uninstall reboot');
            const statement = production.slice(marker).match(/dshInstance = await [^\\r\\n]+/)?.[0];
            if(!statement) throw Error('missing default reboot call');
            const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
            const reboot = new AsyncFunction('bootReleaseDsh','verified','testPort','testRoot','dshInvocation','report','let dshInstance; '+statement+'; return dshInstance');
            await reboot(async(...args)=>{
              facts.bootCalls++; facts.bootTimeout=args[4]; facts.bootErrorSink=typeof args[5]?.onChildError;
              return module.bootReleaseDsh(...args.slice(0,5),{...dependencies,...args[5]});
            },{profile:'synthetic'},50995,${JSON.stringify(root)},{cmd:'NEVER_EXECUTE_DSH',baseArgs:[],isNodeScript:false},report);
          }
          else await module.bootReleaseDsh({profile:'synthetic'},50995,${JSON.stringify(root)},{cmd:'NEVER_EXECUTE_DSH',baseArgs:[],isNodeScript:false},50,dependencies);
          const ids=runner==='maintenance'?module.MAINTENANCE_REQUIRED_IDS:module.RELEASE_REQUIRED_IDS;
          report.observations.push(...ids.map(id=>({id,status:'PASS'})));
        }
      },
      writeReport:report=>writeFileSync(${JSON.stringify(join(root, 'report.json'))},JSON.stringify(report),{flag:'wx'}),
    });
    console.log('LIFECYCLE_FACTS='+JSON.stringify({...facts,exitCode:child.exitCode,signalCode:child.signalCode}));
    process.exitCode=result.exitCode;
  `
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_/i.test(key)))
  Object.assign(env, { HOME: home, USERPROFILE: home, TMP: temporary, TEMP: temporary })
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env, encoding: 'utf8', timeout: 4000 })
  const reportPath = join(root, 'report.json')
  return { result, report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined,
    facts: JSON.parse(/LIFECYCLE_FACTS=(.*)/.exec(result.stdout)?.[1] ?? '{}') }
}

describe('real startup/finalizer lifecycle with controlled child events', () => {
  for (const runner of ['maintenance', 'release'] as const) {
    it.each(['enoent', 'eacces'])(`${runner}: %s saves FAIL, clears timer and exits without stopping never-started child`, (mode) => {
      const { result, report, facts } = scenario(runner, mode)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(report?.verdict).toBe('FAIL')
      expect(result.stdout).toContain('verdict: FAIL | Exit Code: 1')
      expect(facts).toMatchObject({ timers: 1, cleared: 1, stopAttempts: 0, exitCode: null, signalCode: null })
      expect(report?.observations[0].startupState).toMatchObject({ spawnStatus: 'NOT_STARTED', exitConfirmed: false })
    })
    it(`${runner}: error with a PID attempts owned stop and records real confirmation`, () => {
      const { result, report, facts } = scenario(runner, 'pid-present')
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(report?.verdict).toBe('FAIL')
      expect(facts).toMatchObject({ cleared: 1, stopAttempts: 1, exitCode: 0 })
      expect(report?.observations[0].startupState).toMatchObject({ spawnStatus: 'STARTED', exitConfirmed: true })
    })
    it(`${runner}: startup and unconfirmed stop failures both survive reporting`, () => {
      const { result, report, facts } = scenario(runner, 'stop-error')
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(report?.verdict).toBe('FAIL')
      expect(facts).toMatchObject({ cleared: 1, stopAttempts: 1, exitCode: null, signalCode: null })
      expect(JSON.stringify(report)).toContain('synthetic spawn failure')
      expect(JSON.stringify(report)).toContain('synthetic stop unconfirmed')
      expect(report?.observations[0].startupState).toMatchObject({ spawnStatus: 'STARTED', exitConfirmed: false })
    })
    it.each(['timeout', 'early-exit', 'unknown-error'])(`${runner}: %s settles timer and retains truthful child state`, (mode) => {
      const { result, report, facts } = scenario(runner, mode)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(report?.verdict).toBe('FAIL')
      expect(facts.cleared).toBe(1)
      expect(facts.stopAttempts).toBe(mode === 'timeout' ? 1 : 0)
      expect(report?.observations[0].startupState).toMatchObject({ spawnStatus: mode === 'unknown-error' ? 'UNKNOWN' : 'STARTED', exitConfirmed: mode !== 'unknown-error' })
    })
    it(`${runner}: readiness clears timer exactly once and late child error remains FAIL`, () => {
      const ready = scenario(runner, 'ready')
      expect(ready.result.error).toBeUndefined()
      expect(ready.result.status).toBe(0)
      expect(ready.report?.verdict).toBe('PASS')
      expect(ready.facts).toMatchObject({ cleared: 1, stopAttempts: 0 })
      const late = scenario(runner, 'late-error')
      expect(late.result.error).toBeUndefined()
      expect(late.result.status).toBe(1)
      expect(late.report?.verdict).toBe('FAIL')
      expect(JSON.stringify(late.report)).toContain('synthetic late child error')
    })
  }
})

describe('release default post-uninstall reboot call', () => {
  it('resolves the current boot binding and wires the real startup operation', () => {
    const { result, report, facts } = scenario('release', 'reboot-ready')
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(report?.verdict).toBe('PASS')
    expect(result.stdout).toContain('verdict: PASS | Exit Code: 0')
    expect(facts).toMatchObject({ bootCalls: 1, bootTimeout: 90_000, bootErrorSink: 'function', timers: 1, cleared: 1, stopAttempts: 0 })
  })

  it('keeps a second-boot late child error in the report as a redacted FAIL', () => {
    const { result, report, facts } = scenario('release', 'reboot-late-error')
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(report?.verdict).toBe('FAIL')
    expect(result.stdout).toContain('verdict: FAIL | Exit Code: 1')
    expect(facts).toMatchObject({ bootCalls: 1, bootErrorSink: 'function', cleared: 1, stopAttempts: 0 })
    expect(report?.observations).toContainEqual({ id: 'runtime-child-error', status: 'FAIL', message: 'synthetic late child error ?token=REDACTED' })
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_SECRET')
  })
})

describe('release actual cleanup chain', () => {
  it.each(['close-error', 'close-and-stop-error', 'primary-and-cleanup-error'])('%s still attempts owned stop and saves durable FAIL before process exit', (mode) => {
    const { result, report, facts } = scenario('release', mode)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(report?.verdict).toBe('FAIL')
    expect(result.stdout).toContain('verdict: FAIL | Exit Code: 1')
    expect(facts.stopAttempts).toBe(1)
    expect(facts.removeAttempts).toBe(0)
    expect(JSON.stringify(report)).toContain('synthetic browser close failure')
    if (mode !== 'close-error') {
      expect(JSON.stringify(report)).toContain('synthetic stop unconfirmed')
      expect(facts.exitCode).toBeNull()
    }
    if (mode === 'primary-and-cleanup-error') {
      expect(JSON.stringify(report)).toContain('synthetic collection primary failure')
      expect(report?.observations[0].primaryError.message).toBe('synthetic collection primary failure')
      expect(report?.observations[0].cleanupErrors).toHaveLength(2)
    }
  })
})
