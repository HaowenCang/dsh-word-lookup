import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('.', import.meta.url))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_/i.test(key)))
Object.assign(env, { HOME: join(root, 'user'), USERPROFILE: join(root, 'user'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'), APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'), npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'empty-npmrc'), npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' })
const check = spawnSync(process.execPath, ['--input-type=module', '-e', `import os from 'node:os'; import path from 'node:path'; const facts={home:os.homedir(),tmp:os.tmpdir(),dsh:Object.keys(process.env).filter(k=>/^DSH_/i.test(k))}; console.log(JSON.stringify(facts)); if(path.resolve(facts.home)!==path.resolve(process.env.USERPROFILE)||path.resolve(facts.tmp)!==path.resolve(process.env.TEMP)||facts.dsh.length) process.exit(2)`], { env, encoding: 'utf8' })
if (check.status !== 0) throw new Error(check.stdout + check.stderr)
const [label, kind, ...args] = process.argv.slice(2)
const entry = kind === 'test' ? 'node_modules/vitest/vitest.mjs' : kind === 'build' ? 'node_modules/tsdown/dist/run.mjs' : kind === 'typecheck' ? 'node_modules/typescript/bin/tsc' : kind
const command = [entry, ...args]
const result = spawnSync(process.execPath, command, { cwd: join(root, 'repo'), env, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 })
const log = `preflight ${check.stdout}\nnode ${command.join(' ')}\n${result.stdout}\n${result.stderr}\nEXIT_CODE=${result.status}\n${result.error ?? ''}\n`
writeFileSync(join(root, `${label}.log`), log)
process.stdout.write(log.slice(-5000))
process.exitCode = result.status ?? 1
