/**
 * Shared fixtures: real temporary git repositories driven through the real
 * git binary, so the workflows are verified against actual git behavior.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'wtm-test-')))
const globalConfig = join(sandbox, 'gitconfig')
writeFileSync(globalConfig, '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[user]\n\tname = Test\n\temail = test@example.com\n')
process.env['GIT_CONFIG_GLOBAL'] = globalConfig
process.env['GIT_CONFIG_NOSYSTEM'] = '1'

let counter = 0

/** Fresh empty directory inside the sandbox. */
export function tempDir(label: string): string {
  const dir = join(sandbox, `${label}-${String(counter++)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Run git in a directory and return trimmed stdout. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Write a file (creating parents). */
export function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** Create a repository with one commit on `main` and return its directory. */
export function makeRepo(name = 'proj'): string {
  const dir = join(tempDir('repo'), name)
  mkdirSync(dir, { recursive: true })
  sh(dir, 'init', '-q')
  put(join(dir, 'a.txt'), 'one\n')
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** Commit a file change in a checkout. */
export function commitFile(dir: string, file: string, text: string, message: string): void {
  put(join(dir, file), text)
  sh(dir, 'add', '.')
  sh(dir, 'commit', '-q', '-m', message)
}

/** Remove the whole sandbox (called once after the suites). */
export function cleanupSandbox(): void {
  rmSync(sandbox, { recursive: true, force: true })
}
