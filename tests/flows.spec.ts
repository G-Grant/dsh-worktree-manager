import { describe, expect, it, vi } from 'vitest'
import {
  CallError, cleanupAfterMerge, conflictPrompt, describeError, removeWorktreeFully, unwrap,
  type RemovalDeps, type RemovalTarget,
} from '../src/client/flows.ts'
import { pathKey, removalFactsOf, workspaceAt } from '../src/client/facts.ts'

/** Localizer double: renders `key|json(params)` so assertions see both. */
const t = (key: string, params?: Record<string, string | number>): string => `${key}|${JSON.stringify(params ?? {})}`

describe('unwrap / describeError', () => {
  it('returns the body of a successful call', () => {
    expect(unwrap({ ok: true, branch: 'x' } as never)).toMatchObject({ branch: 'x' })
  })

  it('throws a CallError carrying code and details', () => {
    try {
      unwrap({ ok: false, error: 'boom', code: 'conflict', files: ['a', 'b'], count: 2, current: 'dev' } as never)
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(CallError)
      const failure = error as CallError
      expect(failure.code).toBe('conflict')
      expect(failure.files).toEqual(['a', 'b'])
      expect(failure.count).toBe(2)
      expect(failure.current).toBe('dev')
      expect(failure.message).toBe('boom')
    }
  })

  it('maps every error code to its own key', () => {
    const codes = [
      'notRepo', 'branchExists', 'baseMissing', 'invalidName', 'dirty', 'occupied', 'notManaged', 'worktreeDirty',
      'mainNotOnTarget', 'mainDirty', 'nothingToMerge', 'conflict', 'unmerged', 'messageRequired', 'targetMissing',
      'fetchFailed',
    ] as const
    for (const code of codes) {
      const text = describeError(t as never, new CallError({ error: 'm', code, count: 3, current: 'dev', files: ['x'] }))
      expect(text.startsWith(`error.${code}|`), code).toBe(true)
    }
    expect(describeError(t as never, new CallError({ error: 'plain' }))).toMatch(/^error\.generic\|/)
    expect(describeError(t as never, new Error('other'))).toBe('error.generic|{"message":"other"}')
    expect(describeError(t as never, 'str')).toBe('error.generic|{"message":"str"}')
  })

  it('passes counts and the current branch as params', () => {
    const text = describeError(t as never, new CallError({ error: 'm', code: 'mainNotOnTarget', current: 'dev' }))
    expect(text).toContain('"current":"dev"')
    expect(describeError(t as never, new CallError({ error: 'm', code: 'dirty', count: 4 }))).toContain('"count":4')
  })
})

function makeDeps(overrides: Partial<RemovalDeps> = {}): RemovalDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    removeWorktree: async (input) => {
      calls.push(`git:${input.path}:force=${String(input.force)}:deleteBranch=${String(input.deleteBranch)}:forceBranch=${String(input.forceBranch)}`)
      return { branch: 'feat', branchDeleted: input.deleteBranch }
    },
    archiveSession: async (id) => { calls.push(`archive:${id}`) },
    deleteWorkspace: async (id) => { calls.push(`delete:${id}`) },
    ...overrides,
  }
}

function target(overrides: Partial<RemovalTarget> = {}): RemovalTarget {
  return {
    path: '/w/feat',
    repoRoot: '/r',
    force: false,
    deleteBranch: true,
    forceBranch: false,
    facts: { running: false, workspaceId: 'ws1', archiveSessionIds: ['s1', 's2'] },
    ...overrides,
  }
}

describe('removeWorktreeFully', () => {
  it('runs git first, then archives sessions, then unregisters the workspace', async () => {
    const deps = makeDeps()
    const outcome = await removeWorktreeFully(deps, target())
    expect(deps.calls).toEqual([
      'git:/w/feat:force=false:deleteBranch=true:forceBranch=false',
      'archive:s1', 'archive:s2', 'delete:ws1',
    ])
    expect(outcome.leftovers).toEqual([])
    expect(outcome.result.branchDeleted).toBe(true)
  })

  it('touches nothing on the DSH side when git refuses', async () => {
    const deps = makeDeps({ removeWorktree: async () => { throw new CallError({ error: 'dirty', code: 'dirty', count: 1 }) } })
    await expect(removeWorktreeFully(deps, target())).rejects.toBeInstanceOf(CallError)
    expect(deps.calls).toEqual([])
  })

  it('collects DSH-side failures without failing the removal', async () => {
    const deps = makeDeps({
      archiveSession: async (id) => { if (id === 's1') throw new Error('archive failed') },
      deleteWorkspace: async () => { throw new Error('unregister failed') },
    })
    const outcome = await removeWorktreeFully(deps, target())
    expect(outcome.leftovers).toEqual(['archive failed', 'unregister failed'])
  })

  it('skips the workspace step when no workspace sits on the directory', async () => {
    const deps = makeDeps()
    await removeWorktreeFully(deps, target({ facts: { running: false, workspaceId: undefined, archiveSessionIds: [] } }))
    expect(deps.calls).toEqual(['git:/w/feat:force=false:deleteBranch=true:forceBranch=false'])
  })
})

describe('cleanupAfterMerge', () => {
  it('skips when a session in the directory is running', async () => {
    const deps = makeDeps()
    const leave = vi.fn()
    const result = await cleanupAfterMerge(deps, leave, target({ facts: { running: true, workspaceId: 'ws1', archiveSessionIds: [] } }))
    expect(result).toEqual({ done: false, reason: 'running' })
    expect(leave).not.toHaveBeenCalled()
    expect(deps.calls).toEqual([])
  })

  it('leaves the directory first, never forces the worktree, and force-deletes the branch', async () => {
    const order: string[] = []
    const deps = makeDeps({
      removeWorktree: async (input) => {
        order.push('git')
        expect(input.force).toBe(false)
        expect(input.forceBranch).toBe(true)
        return { branch: 'feat', branchDeleted: true }
      },
    })
    const result = await cleanupAfterMerge(deps, () => { order.push('leave') }, target({ force: true }))
    expect(result.done).toBe(true)
    expect(order).toEqual(['leave', 'git'])
  })

  it('keeps the branch when branch deletion is off', async () => {
    const deps = makeDeps()
    await cleanupAfterMerge(deps, () => {}, target({ deleteBranch: false }))
    expect(deps.calls[0]).toContain('deleteBranch=false:forceBranch=false')
  })

  it('reports a failure instead of throwing', async () => {
    const failure = new CallError({ error: 'dirty', code: 'dirty' })
    const deps = makeDeps({ removeWorktree: async () => { throw failure } })
    const result = await cleanupAfterMerge(deps, () => {}, target())
    expect(result).toEqual({ done: false, reason: 'failed', error: failure })
  })
})

describe('conflictPrompt', () => {
  it('writes the handoff in both languages', () => {
    const input = { branch: 'feat', target: 'main', files: ['a.txt', 'b/c.ts'] }
    const zh = conflictPrompt(input, 'zh')
    expect(zh).toContain('将分支 feat 合并到 main')
    expect(zh).toContain('- a.txt')
    expect(zh).toContain('git merge main')
    const en = conflictPrompt(input, 'en')
    expect(en).toContain('Merging branch feat into main')
    expect(en).toContain('- b/c.ts')
    expect(en).toContain('git merge main')
  })
})

describe('facts', () => {
  it('normalizes path keys', () => {
    expect(pathKey('/a/b/')).toBe('/a/b')
    expect(pathKey('/a/b')).toBe('/a/b')
    expect(pathKey('C:\\a\\')).toBe('C:\\a')
    expect(pathKey('/')).toBe('/')
  })

  const workspaces = [
    { workspaceId: 'w1', path: '/w/feat/', title: 't', sessionIds: ['run', 'idle', 'blank', 'sub', 'gone', 'old'] },
    { workspaceId: 'w2', path: '/w/other', sessionIds: ['x'] },
  ]
  const sessions: Record<string, { running: boolean; blank: boolean; origin?: string }> = {
    run: { running: true, blank: false },
    idle: { running: false, blank: false },
    blank: { running: false, blank: true },
    sub: { running: false, blank: false, origin: 'subagent' },
    old: { running: false, blank: false },
  }

  it('derives removal facts from the snapshots', () => {
    const facts = removalFactsOf('/w/feat', workspaces, id => sessions[id], new Set(['old']))
    expect(facts.running).toBe(true)
    expect(facts.workspaceId).toBe('w1')
    expect(facts.archiveSessionIds).toEqual(['run', 'idle'])
  })

  it('answers empty facts for an unregistered directory', () => {
    expect(removalFactsOf('/nowhere', workspaces, id => sessions[id], new Set())).toEqual({
      running: false, workspaceId: undefined, archiveSessionIds: [],
    })
  })

  it('finds the workspace registered on a directory', () => {
    expect(workspaceAt('/w/feat', workspaces)?.workspaceId).toBe('w1')
    expect(workspaceAt('/w/other/', workspaces)?.workspaceId).toBe('w2')
    expect(workspaceAt('/zzz', workspaces)).toBeUndefined()
  })
})
