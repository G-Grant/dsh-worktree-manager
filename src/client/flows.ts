/**
 * Business flows over injected seams, free of React and of the framework
 * services, so they stay unit-testable: failure unwrapping, the shared
 * removal flow and the post-merge cleanup.
 */

import type { Call } from './api.ts'
import type { ErrorCode, RemoveResult, RouteError } from '../wire.ts'

/** A failed route call as an exception. */
export class CallError extends Error {
  readonly code: ErrorCode | undefined
  readonly count: number | undefined
  readonly files: string[] | undefined
  readonly current: string | undefined

  constructor(failure: RouteError) {
    super(failure.error)
    this.name = 'CallError'
    this.code = failure.code
    this.count = failure.count
    this.files = failure.files
    this.current = failure.current
  }
}

/**
 * Unwrap a route call: the success body, or a {@link CallError}.
 * @param call - the settled call.
 */
export function unwrap<T>(call: Call<T>): T {
  if (call.ok) return call
  throw new CallError(call)
}

/** Subset of the localizer the message mapping needs. */
export type Translate = (key: ErrorKey, params?: Record<string, string | number>) => string

/** Locale keys the error mapping may use. */
export type ErrorKey =
  | 'error.generic' | 'error.notRepo' | 'error.branchExists' | 'error.baseMissing' | 'error.invalidName' | 'error.dirty'
  | 'error.occupied' | 'error.notManaged' | 'error.worktreeDirty' | 'error.mainNotOnTarget' | 'error.mainDirty'
  | 'error.nothingToMerge' | 'error.conflict' | 'error.unmerged' | 'error.messageRequired' | 'error.targetMissing'
  | 'error.fetchFailed'

/**
 * Localized one-line message of a failure.
 * @param t - localizer.
 * @param error - a {@link CallError} or any thrown value.
 */
export function describeError(t: Translate, error: unknown): string {
  if (!(error instanceof CallError)) {
    return t('error.generic', { message: error instanceof Error ? error.message : String(error) })
  }
  const params = {
    message: error.message,
    count: error.count ?? 0,
    current: error.current ?? '',
    files: String(error.files?.length ?? 0),
  }
  switch (error.code) {
    case 'notRepo': return t('error.notRepo', params)
    case 'branchExists': return t('error.branchExists', params)
    case 'baseMissing': return t('error.baseMissing', params)
    case 'invalidName': return t('error.invalidName', params)
    case 'dirty': return t('error.dirty', params)
    case 'occupied': return t('error.occupied', params)
    case 'notManaged': return t('error.notManaged', params)
    case 'worktreeDirty': return t('error.worktreeDirty', params)
    case 'mainNotOnTarget': return t('error.mainNotOnTarget', params)
    case 'mainDirty': return t('error.mainDirty', params)
    case 'nothingToMerge': return t('error.nothingToMerge', params)
    case 'conflict': return t('error.conflict', params)
    case 'unmerged': return t('error.unmerged', params)
    case 'messageRequired': return t('error.messageRequired', params)
    case 'targetMissing': return t('error.targetMissing', params)
    case 'fetchFailed': return t('error.fetchFailed', params)
    default: return t('error.generic', params)
  }
}

/** DSH-side facts of one worktree removal, read from live snapshots. */
export interface RemovalFacts {
  /** Any session of the directory's workspace is running. */
  running: boolean
  /** The workspace registration sitting on the directory. */
  workspaceId: string | undefined
  /** Visible sessions to archive. */
  archiveSessionIds: string[]
}

/** What the removal flow talks to. */
export interface RemovalDeps {
  /** The git half; rejects with a {@link CallError}. */
  removeWorktree(input: { path: string; repoRoot: string; force: boolean; deleteBranch: boolean; forceBranch: boolean }): Promise<RemoveResult>
  archiveSession(sessionId: string): Promise<void>
  deleteWorkspace(workspaceId: string): Promise<void>
}

/** One removal request. */
export interface RemovalTarget {
  path: string
  repoRoot: string
  force: boolean
  deleteBranch: boolean
  forceBranch: boolean
  facts: RemovalFacts
}

/** Result of the shared removal flow. */
export interface RemovalOutcome {
  result: RemoveResult
  /** DSH-side steps that failed after git succeeded (never fatal). */
  leftovers: string[]
}

/**
 * Remove a worktree COMPLETELY: git first, so a refusal leaves everything
 * intact; afterwards the directory's sessions are archived and its workspace
 * registration dropped, each best effort.
 * @param deps - seams.
 * @param target - the request.
 */
export async function removeWorktreeFully(deps: RemovalDeps, target: RemovalTarget): Promise<RemovalOutcome> {
  const result = await deps.removeWorktree({
    path: target.path, repoRoot: target.repoRoot, force: target.force, deleteBranch: target.deleteBranch, forceBranch: target.forceBranch,
  })
  const leftovers: string[] = []
  for (const sessionId of target.facts.archiveSessionIds) {
    try {
      await deps.archiveSession(sessionId)
    } catch (error) {
      leftovers.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (target.facts.workspaceId !== undefined) {
    try {
      await deps.deleteWorkspace(target.facts.workspaceId)
    } catch (error) {
      leftovers.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { result, leftovers }
}

/** Outcome of the post-merge cleanup. */
export type CleanupOutcome =
  | { done: true; outcome: RemovalOutcome }
  | { done: false; reason: 'running' }
  | { done: false; reason: 'failed'; error: unknown }

/**
 * Clean up after a successful merge. A running session in the directory
 * skips the cleanup; otherwise the view first leaves the directory (so the
 * navigation does not point at a vanishing session) and the shared removal
 * runs with the branch force-deleted (a squash merge never counts as merged
 * for git, yet its content is in the target).
 * @param deps - removal seams.
 * @param leave - navigate away from the directory (no-op when not inside it).
 * @param target - the removal request; `force` is always pinned to false.
 */
export async function cleanupAfterMerge(deps: RemovalDeps, leave: () => void, target: RemovalTarget): Promise<CleanupOutcome> {
  if (target.facts.running) return { done: false, reason: 'running' }
  try {
    leave()
    const outcome = await removeWorktreeFully(deps, { ...target, force: false, forceBranch: target.deleteBranch })
    return { done: true, outcome }
  } catch (error) {
    return { done: false, reason: 'failed', error }
  }
}

/**
 * Build the message that hands a merge conflict to the agent.
 * @param input - branch, target and conflicting files.
 * @param locale - which language to write in.
 */
export function conflictPrompt(input: { branch: string; target: string; files: readonly string[] }, locale: 'zh' | 'en'): string {
  const list = input.files.map(file => `- ${file}`).join('\n')
  if (locale === 'zh') {
    return [
      `将分支 ${input.branch} 合并到 ${input.target} 时，以下文件存在冲突：`,
      list,
      '',
      `请在当前 worktree 中执行 \`git merge ${input.target}\`，解决全部冲突并提交。完成后告诉我，我会重新发起合并。`,
    ].join('\n')
  }
  return [
    `Merging branch ${input.branch} into ${input.target} conflicts in these files:`,
    list,
    '',
    `In this worktree run \`git merge ${input.target}\`, resolve every conflict and commit. Tell me when done and I will retry the merge.`,
  ].join('\n')
}
