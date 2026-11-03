import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  childProcessExec, collectSquashInput, createWorktree, fallbackSquashMessage, GitError, inspectWorktree, listManaged,
  mergeWorktree, parseWorktreeList, probeRepo, removeManaged, repoStatus, switchBranch, worktreeStorageDir, WtError,
} from '../src/git.js'
import { cleanupSandbox, commitFile, makeRepo, put, sh, tempDir } from './helpers.js'

afterAll(cleanupSandbox)

const exec = childProcessExec

/** Create a managed worktree named `name` from `main`. */
async function newWorktree(repo: string, name: string): Promise<{ path: string }> {
  const result = await createWorktree(exec, { cwd: repo, name, base: 'main', copyFiles: [] })
  return { path: result.path }
}

async function failure(promise: Promise<unknown>): Promise<WtError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(WtError)
    return error as WtError
  }
  throw new Error('expected a WtError')
}

describe('parseWorktreeList', () => {
  it('parses main, linked, detached and prunable records', () => {
    const text = [
      'worktree /r', 'HEAD abc', 'branch refs/heads/main', '',
      'worktree /w', 'HEAD def', 'branch refs/heads/feat/x', '',
      'worktree /d', 'HEAD 123', 'detached', '',
      'worktree /p', 'HEAD 456', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
    ].join('\n')
    const records = parseWorktreeList(text)
    expect(records.map(record => record.branch)).toEqual(['main', 'feat/x', undefined, 'gone'])
    expect(records[3]?.prunable).toBe(true)
    expect(records[0]?.prunable).toBe(false)
  })
})

describe('probeRepo / repoStatus', () => {
  it('reports non-git and missing directories as not a repo', async () => {
    expect(await probeRepo(exec, tempDir('plain'))).toBeUndefined()
    expect(await probeRepo(exec, '/definitely/not/here')).toBeUndefined()
    expect(await repoStatus(exec, tempDir('plain'))).toEqual({ repo: false })
  })

  it('describes the main checkout', async () => {
    const repo = makeRepo('alpha')
    sh(repo, 'branch', 'other')
    const status = await repoStatus(exec, repo)
    if (!status.repo) throw new Error('expected a repo')
    expect(status.repoName).toBe('alpha')
    expect(status.main).toBe(true)
    expect(status.currentBranch).toBe('main')
    expect(status.dirty).toBe(0)
    expect(status.managed).toBeUndefined()
    expect(status.branches.map(branch => branch.name).sort()).toEqual(['main', 'other'])
    expect(status.branches.find(branch => branch.name === 'main')?.current).toBe(true)
  })

  it('counts uncommitted entries', async () => {
    const repo = makeRepo()
    put(join(repo, 'new.txt'), 'x')
    put(join(repo, 'a.txt'), 'changed')
    const status = await repoStatus(exec, repo)
    expect(status.repo && status.dirty).toBe(2)
  })

  it('works from a subdirectory', async () => {
    const repo = makeRepo()
    put(join(repo, 'sub', 'f.txt'), 'x')
    const status = await repoStatus(exec, join(repo, 'sub'))
    expect(status.repo && status.main).toBe(true)
  })

  it('identifies a managed worktree and marks occupied branches', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-a')
    const fromWorktree = await repoStatus(exec, path)
    if (!fromWorktree.repo) throw new Error('expected a repo')
    expect(fromWorktree.main).toBe(false)
    expect(fromWorktree.managed).toEqual({ branch: 'feat-a', base: 'main' })
    expect(fromWorktree.mainCheckout).toEqual({ path: repo, branch: 'main', dirty: 0 })
    expect(fromWorktree.branches.find(branch => branch.name === 'main')?.occupiedBy).toBeDefined()
    expect(fromWorktree.branches.find(branch => branch.name === 'feat-a')?.occupiedBy).toBeUndefined()
    const fromMain = await repoStatus(exec, repo)
    if (!fromMain.repo) throw new Error('expected a repo')
    expect(fromMain.branches.find(branch => branch.name === 'feat-a')?.occupiedBy).toBe(path)
    expect(fromMain.mainCheckout).toBeUndefined()
  })

  it('lists remote-only branches and drops local twins', async () => {
    const origin = makeRepo('origin-src')
    sh(origin, 'branch', 'remote-only')
    sh(origin, 'branch', 'twin')
    const clone = join(tempDir('clone'), 'clone')
    sh(tempDir('x'), 'clone', '-q', origin, clone)
    sh(clone, 'branch', 'twin', 'origin/twin')
    const status = await repoStatus(exec, clone)
    if (!status.repo) throw new Error('expected a repo')
    const names = status.branches.map(branch => `${branch.name}:${String(branch.remote)}`).sort()
    expect(names).toEqual(['main:false', 'origin/remote-only:true', 'twin:false'])
  })
})

describe('createWorktree', () => {
  it('creates <repo>/.agents/worktrees/<name> on a new branch and records the base', async () => {
    const repo = makeRepo('gis-mfg')
    const result = await createWorktree(exec, { cwd: repo, name: 'feat/login', base: 'main', copyFiles: [] })
    expect(result.path).toBe(join(worktreeStorageDir(repo), 'feat-login'))
    expect(result.branch).toBe('feat/login')
    expect(result.base).toBe('main')
    expect(result.title).toBe('feat/login')
    expect(existsSync(join(result.path, 'a.txt'))).toBe(true)
    expect(sh(repo, 'config', '--get', 'branch.feat/login.dsh-worktree-base')).toBe('main')
    expect(sh(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/login')
    expect(readFileSync(join(worktreeStorageDir(repo), '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('keeps a Chinese name as the branch, the title, and the directory', async () => {
    const repo = makeRepo('gis-mfg')
    const result = await createWorktree(exec, { cwd: repo, name: '登录修复', base: 'main', copyFiles: [] })
    expect(result.path).toBe(join(worktreeStorageDir(repo), '登录修复'))
    expect(result.branch).toBe('登录修复')
    expect(result.title).toBe('登录修复')
    expect(sh(repo, 'config', '--get', 'branch.登录修复.dsh-worktree-base')).toBe('main')
    expect(sh(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('登录修复')
  })

  it('generates wt-xxxxxx when no name is given and avoids taken names', async () => {
    const repo = makeRepo()
    const first = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    const second = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2])
    const queue = [first, first, second]
    const random = (): Uint8Array => queue.shift() as Uint8Array
    const a = await createWorktree(exec, { cwd: repo, base: 'main', copyFiles: [], random })
    expect(a.branch).toMatch(/^wt-[a-z0-9]{6}$/)
    const b = await createWorktree(exec, { cwd: repo, base: 'main', copyFiles: [], random })
    expect(b.branch).not.toBe(a.branch)
  })

  it('rejects an existing branch name', async () => {
    const repo = makeRepo()
    sh(repo, 'branch', 'taken')
    const error = await failure(createWorktree(exec, { cwd: repo, name: 'taken', base: 'main', copyFiles: [] }))
    expect(error.code).toBe('branchExists')
  })

  it('rejects invalid names and missing bases', async () => {
    const repo = makeRepo()
    expect((await failure(createWorktree(exec, { cwd: repo, name: 'bad name', base: 'main', copyFiles: [] }))).code).toBe('invalidName')
    expect((await failure(createWorktree(exec, { cwd: repo, name: 'ok', base: 'nope', copyFiles: [] }))).code).toBe('baseMissing')
  })

  it('rejects a directory that is not a repository', async () => {
    const error = await failure(createWorktree(exec, { cwd: tempDir('plain'), name: 'x', base: 'main', copyFiles: [] }))
    expect(error.code).toBe('notRepo')
  })

  it('adds a numeric suffix when the directory is taken', async () => {
    const repo = makeRepo()
    put(join(worktreeStorageDir(repo), 'feat-a', 'keep.txt'), 'x')
    const result = await createWorktree(exec, { cwd: repo, name: 'feat-a', base: 'main', copyFiles: [] })
    expect(result.path).toBe(join(worktreeStorageDir(repo), 'feat-a-2'))
  })

  it('bases on a remote branch without tracking it and records the local name', async () => {
    const origin = makeRepo('origin-src')
    sh(origin, 'checkout', '-q', '-b', 'release')
    commitFile(origin, 'r.txt', 'r', 'release commit')
    sh(origin, 'checkout', '-q', 'main')
    const clone = join(tempDir('clone'), 'clone')
    sh(tempDir('x'), 'clone', '-q', origin, clone)
    const result = await createWorktree(exec, { cwd: clone, name: 'from-release', base: 'origin/release', copyFiles: [] })
    expect(result.base).toBe('release')
    expect(existsSync(join(result.path, 'r.txt'))).toBe(true)
    expect(() => sh(result.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow()
  })

  it('works when asked from inside another worktree', async () => {
    const repo = makeRepo('proj')
    const first = await createWorktree(exec, { cwd: repo, name: 'one', base: 'main', copyFiles: [] })
    const second = await createWorktree(exec, { cwd: first.path, name: 'two', base: 'main', copyFiles: [] })
    expect(second.repoName).toBe('proj')
    expect(second.path).toBe(join(worktreeStorageDir(repo), 'two'))
  })

  it('copies .worktreeinclude and configured files without failing the creation', async () => {
    const repo = makeRepo()
    put(join(repo, '.gitignore'), '.env\n.env.*\nsecrets/\n')
    sh(repo, 'add', '.')
    sh(repo, 'commit', '-q', '-m', 'ignore')
    put(join(repo, '.env'), 'A=1')
    put(join(repo, '.env.local'), 'B=2')
    put(join(repo, 'secrets', 'k.txt'), 'key')
    put(join(repo, '.worktreeinclude'), '# local files\n.env\nsecrets\nmissing.txt\n')
    const result = await createWorktree(exec, { cwd: repo, name: 'copy-me', base: 'main', copyFiles: ['.env.*', '../escape'] })
    expect(result.copied.sort()).toEqual(['.env', '.env.local', 'secrets'])
    expect(readFileSync(join(result.path, '.env'), 'utf8')).toBe('A=1')
    expect(readFileSync(join(result.path, 'secrets', 'k.txt'), 'utf8')).toBe('key')
    expect(result.copyWarnings.some(item => item.includes('missing.txt'))).toBe(true)
    expect(result.copyWarnings.some(item => item.includes('../escape'))).toBe(true)
  })

  it('skips fetch when the repository has no remote', async () => {
    const repo = makeRepo()
    const result = await createWorktree(exec, { cwd: repo, name: 'offline', base: 'main', copyFiles: [], fetchBase: true })
    expect(result.branch).toBe('offline')
    expect(existsSync(join(result.path, 'a.txt'))).toBe(true)
  })

  it('fetches the base remote so the new worktree is not cut from a stale local branch', async () => {
    const origin = makeRepo('origin-src')
    const clone = join(tempDir('clone'), 'clone')
    sh(tempDir('x'), 'clone', '-q', origin, clone)
    commitFile(origin, 'fresh.txt', 'new', 'ahead')
    const stale = await createWorktree(exec, {
      cwd: clone, name: 'stale', base: 'main', copyFiles: [], fetchBase: false,
    })
    expect(existsSync(join(stale.path, 'fresh.txt'))).toBe(false)
    const fresh = await createWorktree(exec, {
      cwd: clone, name: 'fresh', base: 'main', copyFiles: [], fetchBase: true,
    })
    expect(existsSync(join(fresh.path, 'fresh.txt'))).toBe(true)
    expect(sh(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(existsSync(join(clone, 'fresh.txt'))).toBe(false)
  })

  it('refuses to create when fetching the base fails', async () => {
    const origin = makeRepo('origin-src')
    const clone = join(tempDir('clone'), 'clone')
    sh(tempDir('x'), 'clone', '-q', origin, clone)
    sh(clone, 'remote', 'set-url', 'origin', join(tempDir('gone'), 'missing.git'))
    const error = await failure(createWorktree(exec, {
      cwd: clone, name: 'no-fetch', base: 'main', copyFiles: [], fetchBase: true,
    }))
    expect(error.code).toBe('fetchFailed')
  })
})

describe('listManaged / inspectWorktree', () => {
  it('lists only worktrees created by the plugin', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'managed-1')
    sh(repo, 'worktree', 'add', '-q', '-b', 'foreign', join(tempDir('foreign'), 'f'))
    commitFile(path, 'x.txt', 'x', 'work')
    const entries = await listManaged(exec, [repo, path, '/not/here'])
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry).toMatchObject({ path, branch: 'managed-1', base: 'main', ahead: 1, dirty: 0, merged: false, missing: false })
  })

  it('reports dirty, missing and merged states', async () => {
    const repo = makeRepo()
    const a = await newWorktree(repo, 'clean-merged')
    const b = await newWorktree(repo, 'gone')
    put(join(a.path, 'u.txt'), 'u')
    const inspected = await inspectWorktree(exec, a.path)
    expect(inspected.dirty).toBe(1)
    expect(inspected.merged).toBe(true)
    expect(inspected.ahead).toBe(0)
    const { rmSync } = await import('node:fs')
    rmSync(b.path, { recursive: true, force: true })
    const entries = await listManaged(exec, [repo])
    const missing = entries.find(entry => entry.branch === 'gone')
    expect(missing).toMatchObject({ missing: true, dirty: 0 })
  })

  it('refuses to inspect the main checkout and unmanaged worktrees', async () => {
    const repo = makeRepo()
    const foreign = join(tempDir('foreign'), 'f')
    sh(repo, 'worktree', 'add', '-q', '-b', 'foreign', foreign)
    expect((await failure(inspectWorktree(exec, repo))).code).toBe('notManaged')
    expect((await failure(inspectWorktree(exec, foreign))).code).toBe('notManaged')
    expect((await failure(inspectWorktree(exec, '/not/here'))).code).toBe('notManaged')
  })
})

describe('mergeWorktree', () => {
  it('merges with a merge commit (--no-ff)', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-m')
    commitFile(path, 'm.txt', 'm', 'add m')
    const result = await mergeWorktree(exec, { path, strategy: 'merge' })
    expect(result).toMatchObject({ target: 'main', strategy: 'merge', branch: 'feat-m' })
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(result.commit)
    expect(sh(repo, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2)
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe("Merge branch 'feat-m'")
    expect(existsSync(join(repo, 'm.txt'))).toBe(true)
  })

  it('honours a custom merge message', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-msg')
    commitFile(path, 'm.txt', 'm', 'add m')
    await mergeWorktree(exec, { path, strategy: 'merge', message: 'custom merge' })
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('custom merge')
  })

  it('squashes all commits into one', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-s')
    commitFile(path, 's1.txt', '1', 'first')
    commitFile(path, 's2.txt', '2', 'second')
    const before = sh(repo, 'rev-list', '--count', 'HEAD')
    const result = await mergeWorktree(exec, { path, strategy: 'squash', message: 'feat: squashed' })
    expect(Number(sh(repo, 'rev-list', '--count', 'HEAD')) - Number(before)).toBe(1)
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('feat: squashed')
    expect(sh(repo, 'log', '-1', '--format=%P').split(' ')).toHaveLength(1)
    expect(existsSync(join(repo, 's1.txt')) && existsSync(join(repo, 's2.txt'))).toBe(true)
    expect(result.strategy).toBe('squash')
  })

  it('requires a message for squash', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-nm')
    commitFile(path, 's.txt', 's', 'work')
    expect((await failure(mergeWorktree(exec, { path, strategy: 'squash', message: '  ' }))).code).toBe('messageRequired')
  })

  it('refuses a dirty worktree', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-d')
    commitFile(path, 's.txt', 's', 'work')
    put(join(path, 'dirty.txt'), 'd')
    const error = await failure(mergeWorktree(exec, { path, strategy: 'merge' }))
    expect(error.code).toBe('worktreeDirty')
    expect(error.extra.count).toBe(1)
  })

  it('refuses when the main checkout is not on the target branch', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-t')
    commitFile(path, 's.txt', 's', 'work')
    sh(repo, 'switch', '-q', '-c', 'elsewhere')
    const error = await failure(mergeWorktree(exec, { path, strategy: 'merge' }))
    expect(error.code).toBe('mainNotOnTarget')
    expect(error.extra.current).toBe('elsewhere')
  })

  it('refuses when the main checkout is dirty', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-md')
    commitFile(path, 's.txt', 's', 'work')
    put(join(repo, 'wip.txt'), 'w')
    expect((await failure(mergeWorktree(exec, { path, strategy: 'merge' }))).code).toBe('mainDirty')
  })

  it('refuses an empty merge', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-e')
    expect((await failure(mergeWorktree(exec, { path, strategy: 'merge' }))).code).toBe('nothingToMerge')
  })

  it('refuses a missing target branch', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-x')
    commitFile(path, 's.txt', 's', 'work')
    expect((await failure(mergeWorktree(exec, { path, strategy: 'merge', target: 'nope' }))).code).toBe('targetMissing')
  })

  it.each(['merge', 'squash'] as const)('rolls back a %s conflict and reports the files', async (strategy) => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, `feat-c-${strategy}`)
    commitFile(path, 'a.txt', 'from worktree\n', 'wt change')
    commitFile(repo, 'a.txt', 'from main\n', 'main change')
    const head = sh(repo, 'rev-parse', 'HEAD')
    const error = await failure(mergeWorktree(exec, { path, strategy, message: 'conflicting' }))
    expect(error.code).toBe('conflict')
    expect(error.extra.files).toEqual(['a.txt'])
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(sh(repo, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('from main\n')
  })

  it('merges into a non-default target when the main checkout is on it', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-r')
    commitFile(path, 's.txt', 's', 'work')
    sh(repo, 'switch', '-q', '-c', 'integration')
    const result = await mergeWorktree(exec, { path, strategy: 'merge', target: 'integration' })
    expect(result.target).toBe('integration')
  })
})

describe('removeManaged', () => {
  it('removes a clean merged worktree and deletes the branch with -d', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-r1')
    commitFile(path, 's.txt', 's', 'work')
    await mergeWorktree(exec, { path, strategy: 'merge' })
    const result = await removeManaged(exec, { path, force: false, deleteBranch: true, forceBranch: false })
    expect(result).toEqual({ branch: 'feat-r1', branchDeleted: true })
    expect(existsSync(path)).toBe(false)
    expect(sh(repo, 'branch', '--list', 'feat-r1')).toBe('')
  })

  it('asks for force on uncommitted changes', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-r2')
    put(join(path, 'u.txt'), 'u')
    const error = await failure(removeManaged(exec, { path, force: false, deleteBranch: false, forceBranch: false }))
    expect(error.code).toBe('dirty')
    expect(error.extra.count).toBe(1)
    await removeManaged(exec, { path, force: true, deleteBranch: false, forceBranch: false })
    expect(existsSync(path)).toBe(false)
    expect(sh(repo, 'branch', '--list', 'feat-r2')).toContain('feat-r2')
  })

  it('refuses to delete an unmerged branch without forceBranch, and deletes it with it', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-r3')
    commitFile(path, 's.txt', 's', 'unmerged work')
    const error = await failure(removeManaged(exec, { path, force: false, deleteBranch: true, forceBranch: false }))
    expect(error.code).toBe('unmerged')
    expect(existsSync(path)).toBe(true)
    await removeManaged(exec, { path, force: false, deleteBranch: true, forceBranch: true })
    expect(sh(repo, 'branch', '--list', 'feat-r3')).toBe('')
  })

  it('cleans up after a squash merge when forced', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-r4')
    commitFile(path, 's.txt', 's', 'work')
    await mergeWorktree(exec, { path, strategy: 'squash', message: 'squashed' })
    expect((await failure(removeManaged(exec, { path, force: false, deleteBranch: true, forceBranch: false }))).code).toBe('unmerged')
    await removeManaged(exec, { path, force: false, deleteBranch: true, forceBranch: true })
    expect(existsSync(path)).toBe(false)
  })

  it('removes the registration of a worktree whose directory is gone', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-r5')
    const { rmSync } = await import('node:fs')
    rmSync(path, { recursive: true, force: true })
    const result = await removeManaged(exec, { path, repoRoot: repo, force: false, deleteBranch: true, forceBranch: true })
    expect(result.branchDeleted).toBe(true)
    expect(sh(repo, 'worktree', 'list', '--porcelain')).not.toContain(path)
  })

  it('refuses unmanaged targets', async () => {
    const repo = makeRepo()
    expect((await failure(removeManaged(exec, { path: repo, force: true, deleteBranch: true, forceBranch: true }))).code).toBe('notManaged')
    expect(existsSync(repo)).toBe(true)
  })
})

describe('switchBranch', () => {
  it('switches a clean checkout', async () => {
    const repo = makeRepo()
    sh(repo, 'branch', 'other')
    expect(await switchBranch(exec, repo, 'other')).toBe('other')
    expect(sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('other')
  })

  it('refuses on uncommitted changes', async () => {
    const repo = makeRepo()
    sh(repo, 'branch', 'other')
    put(join(repo, 'wip.txt'), 'w')
    const error = await failure(switchBranch(exec, repo, 'other'))
    expect(error.code).toBe('dirty')
  })

  it('refuses a branch another worktree holds', async () => {
    const repo = makeRepo()
    await newWorktree(repo, 'held')
    expect((await failure(switchBranch(exec, repo, 'held'))).code).toBe('occupied')
  })

  it('creates a tracking branch for a remote-only branch', async () => {
    const origin = makeRepo('origin-src')
    sh(origin, 'branch', 'remote-only')
    const clone = join(tempDir('clone'), 'clone')
    sh(tempDir('x'), 'clone', '-q', origin, clone)
    expect(await switchBranch(exec, clone, 'origin/remote-only')).toBe('remote-only')
    expect(sh(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('remote-only')
  })

  it('rejects unknown branches and non-repos', async () => {
    const repo = makeRepo()
    expect((await failure(switchBranch(exec, repo, 'nope'))).code).toBe('baseMissing')
    expect((await failure(switchBranch(exec, tempDir('plain'), 'x'))).code).toBe('notRepo')
  })
})

describe('squash drafting inputs', () => {
  it('collects subjects oldest first, stat and diff', async () => {
    const repo = makeRepo()
    const { path } = await newWorktree(repo, 'feat-q')
    commitFile(path, 'q1.txt', '1', 'first change')
    commitFile(path, 'q2.txt', '2', 'second change')
    const input = await collectSquashInput(exec, path)
    expect(input.subjects).toEqual(['first change', 'second change'])
    expect(input.stat).toContain('q1.txt')
    expect(input.diff).toContain('q2.txt')
  })

  it('builds the fallback message', () => {
    expect(fallbackSquashMessage([], 'b')).toBe('Merge b')
    expect(fallbackSquashMessage(['only'], 'b')).toBe('only')
    expect(fallbackSquashMessage(['a', 'b'], 'x')).toBe('a\n\n- a\n- b')
  })
})

describe('GitError', () => {
  it('carries the diagnostic text', async () => {
    const repo = makeRepo()
    const { git } = await import('../src/git.js')
    await expect(git(exec, repo, ['switch', 'no-such-branch'])).rejects.toBeInstanceOf(GitError)
  })
})
