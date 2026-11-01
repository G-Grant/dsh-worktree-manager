import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateConfig } from '../src/index.js'
import {
  handleCreate, handleInspect, handleList, handleMerge, handleRemove, handleSquashMessage, handleStatus, handleSwitch,
  failure, type LlmStreamRuntime, type RouteDeps,
} from '../src/routes.js'
import { childProcessExec, GitError, WtError } from '../src/git.js'
import type { CreateResult, MergeResult, RepoStatus, RouteError, SquashMessageResult, WorktreeEntry } from '../src/wire.js'
import { cleanupSandbox, commitFile, makeRepo, sh, tempDir } from './helpers.js'

afterAll(cleanupSandbox)

function depsWith(root: string, copyFiles: string[] = []): RouteDeps {
  return {
    exec: childProcessExec,
    sectionRootDir: () => root,
    sectionCopyFiles: () => copyFiles,
    home: () => '/home/nobody',
    envHome: () => undefined,
  }
}

describe('request validation', () => {
  const deps = depsWith('/tmp/unused')
  it('rejects relative or missing paths', async () => {
    expect((await handleStatus(deps, undefined)).status).toBe(400)
    expect((await handleStatus(deps, 'relative/dir')).status).toBe(400)
    expect((await handleSwitch(deps, { path: 'rel', branch: 'x' })).status).toBe(400)
    expect((await handleCreate(deps, { path: 'rel', base: 'main' })).status).toBe(400)
    expect((await handleInspect(deps, { path: 'rel' })).status).toBe(400)
    expect((await handleMerge(deps, { path: 'rel', strategy: 'merge' })).status).toBe(400)
    expect((await handleSquashMessage(deps, undefined, { path: 'rel' })).status).toBe(400)
  })

  it('rejects malformed bodies', async () => {
    expect((await handleSwitch(deps, 'nope')).status).toBe(400)
    expect((await handleSwitch(deps, { path: '/a' })).status).toBe(400)
    expect((await handleCreate(deps, { path: '/a', base: '-x' })).status).toBe(400)
    expect((await handleCreate(deps, { path: '/a', base: 'main', name: 3 })).status).toBe(400)
    expect((await handleMerge(deps, { path: '/a', strategy: 'rebase' })).status).toBe(400)
    expect((await handleMerge(deps, { path: '/a', strategy: 'merge', target: '-x' })).status).toBe(400)
    expect((await handleRemove(deps, { path: '/a', force: 'yes', deleteBranch: true, forceBranch: true })).status).toBe(400)
    expect((await handleRemove(deps, { path: '/a', repoRoot: 'rel', force: true, deleteBranch: true, forceBranch: true })).status).toBe(400)
    expect((await handleList(deps, { paths: 'x' })).status).toBe(400)
    expect((await handleList(deps, { paths: [1] })).status).toBe(400)
    expect((await handleSwitch(deps, { path: '/a', branch: '--force' })).status).toBe(400)
  })
})

describe('failure mapping', () => {
  it('maps domain, git and unknown errors', () => {
    expect(failure(new WtError('x', 'notRepo')).status).toBe(400)
    expect(failure(new WtError('x', 'invalidName')).status).toBe(400)
    expect(failure(new WtError('x', 'messageRequired')).status).toBe(400)
    const conflict = failure(new WtError('x', 'conflict', { files: ['a'] }))
    expect(conflict.status).toBe(409)
    expect(conflict.body).toEqual({ error: 'x', code: 'conflict', files: ['a'] })
    expect(failure(new GitError(['x'], 1, 'boom')).status).toBe(400)
    expect(failure(new Error('weird')).status).toBe(500)
    expect(failure('str').status).toBe(500)
  })
})

describe('end to end through the routes', () => {
  it('status → create → list → merge → remove', async () => {
    const repo = makeRepo('gis-mfg')
    const deps = depsWith(tempDir('root'))

    const status = (await handleStatus(deps, repo)).body as RepoStatus
    expect(status.repo && status.repoName).toBe('gis-mfg')

    const created = await handleCreate(deps, { path: repo, name: 'feat-x', base: 'main' })
    expect(created.status).toBe(200)
    const worktree = created.body as CreateResult
    expect(worktree.title).toBe('gis-mfg.feat-x')

    const duplicate = await handleCreate(deps, { path: repo, name: 'feat-x', base: 'main' })
    expect(duplicate.status).toBe(409)
    expect((duplicate.body as RouteError).code).toBe('branchExists')

    commitFile(worktree.path, 'f.txt', 'f', 'feature work')
    const listed = (await handleList(deps, { paths: [repo] })).body as { worktrees: WorktreeEntry[] }
    expect(listed.worktrees.map(entry => entry.branch)).toEqual(['feat-x'])
    expect(listed.worktrees[0]?.ahead).toBe(1)

    const inspected = await handleInspect(deps, { path: worktree.path })
    expect(inspected.status).toBe(200)

    const dirtyRefusal = await handleRemove(deps, { path: worktree.path, force: false, deleteBranch: true, forceBranch: false })
    expect(dirtyRefusal.status).toBe(409)
    expect((dirtyRefusal.body as RouteError).code).toBe('unmerged')

    const merged = await handleMerge(deps, { path: worktree.path, strategy: 'squash', message: 'feat: x' })
    expect(merged.status).toBe(200)
    expect((merged.body as MergeResult).target).toBe('main')

    const removed = await handleRemove(deps, { path: worktree.path, force: false, deleteBranch: true, forceBranch: true })
    expect(removed.status).toBe(200)
    expect(sh(repo, 'branch', '--list', 'feat-x')).toBe('')
  })

  it('switches branches and reports dirty trees', async () => {
    const repo = makeRepo()
    sh(repo, 'branch', 'other')
    const deps = depsWith(tempDir('root'))
    const ok = await handleSwitch(deps, { path: repo, branch: 'other' })
    expect(ok.status).toBe(200)
    commitFile(repo, 'x.txt', 'x', 'x')
    sh(repo, 'switch', '-q', 'main')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(repo, 'wip.txt'), 'w')
    const refused = await handleSwitch(deps, { path: repo, branch: 'other' })
    expect(refused.status).toBe(409)
    expect((refused.body as RouteError).code).toBe('dirty')
  })
})

describe('handleSquashMessage', () => {
  async function prepared(): Promise<{ deps: RouteDeps; path: string }> {
    const repo = makeRepo()
    const deps = depsWith(tempDir('root'))
    const created = (await handleCreate(deps, { path: repo, name: 'feat-sq', base: 'main' })).body as CreateResult
    commitFile(created.path, 'a1.txt', '1', 'add a1')
    commitFile(created.path, 'a2.txt', '2', 'add a2')
    return { deps, path: created.path }
  }

  const fakeLlm = (reply: string, throwAfter = false): LlmStreamRuntime => ({
    async *stream() {
      yield { type: 'reasoning-delta', text: 'ignored' }
      yield { type: 'text-delta', text: reply }
      if (throwAfter) throw new Error('stream broke')
    },
  })

  it('falls back to the subject list without an llm or a model route', async () => {
    const { deps, path } = await prepared()
    const withoutLlm = (await handleSquashMessage(deps, undefined, { path })).body as SquashMessageResult
    expect(withoutLlm.ai).toBe(false)
    expect(withoutLlm.message).toBe('add a1\n\n- add a1\n- add a2')
    const withoutModel = (await handleSquashMessage(deps, fakeLlm('x'), { path })).body as SquashMessageResult
    expect(withoutModel.ai).toBe(false)
  })

  it('uses the model reply when available and strips fences', async () => {
    const { deps, path } = await prepared()
    const result = (await handleSquashMessage(deps, fakeLlm('```\nfeat: add a1 and a2\n```'), { path, provider: 'p', model: 'm', effort: 'high' })).body as SquashMessageResult
    expect(result).toMatchObject({ ai: true, message: 'feat: add a1 and a2', subjects: ['add a1', 'add a2'] })
  })

  it('falls back when the model fails or answers nothing', async () => {
    const { deps, path } = await prepared()
    const broken = (await handleSquashMessage(deps, fakeLlm('', true), { path, provider: 'p', model: 'm' })).body as SquashMessageResult
    expect(broken.ai).toBe(false)
    const empty = (await handleSquashMessage(deps, fakeLlm('   '), { path, provider: 'p', model: 'm' })).body as SquashMessageResult
    expect(empty.ai).toBe(false)
  })

  it('rejects unmanaged directories', async () => {
    const repo = makeRepo()
    const result = await handleSquashMessage(depsWith(tempDir('root')), undefined, { path: repo })
    expect(result.status).toBe(409)
  })
})

describe('validateConfig', () => {
  it('accepts the defaults and a full config', () => {
    expect(() => validateConfig({})).not.toThrow()
    expect(() => validateConfig({ rootDir: '/abs', namingMode: 'auto', autoCleanup: false, deleteBranchOnCleanup: false, copyFiles: ['.env'] })).not.toThrow()
  })
  it('rejects unknown keys and bad values', () => {
    expect(() => validateConfig({ nope: 1 } as never)).toThrow(/unknown key/)
    expect(() => validateConfig({ rootDir: '' })).toThrow()
    expect(() => validateConfig({ rootDir: 'rel' })).toThrow(/absolute/)
    expect(() => validateConfig({ namingMode: 'hash' as never })).toThrow()
    expect(() => validateConfig({ autoCleanup: 'yes' as never })).toThrow()
    expect(() => validateConfig({ copyFiles: ['../x'] })).toThrow(/safe relative/)
    expect(() => validateConfig({ copyFiles: [1] as never })).toThrow()
  })
})
