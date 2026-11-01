/**
 * Pure derivations over the live workspace / session snapshots.
 */

import type { RemovalFacts } from './flows.ts'

/** Workspace row as the derivations need it. */
export interface WorkspaceLike {
  workspaceId: string
  path: string
  title?: string
  sessionIds: readonly string[]
}

/** Session summary as the derivations need it. */
export interface SessionLike {
  running: boolean
  blank: boolean
  origin?: string
}

/**
 * Comparison key of a directory path: trailing separators stripped.
 * @param path - directory path.
 */
export function pathKey(path: string): string {
  const stripped = path.replace(/[\\/]+$/, '')
  return stripped === '' ? path : stripped
}

/**
 * The DSH-side facts of one worktree removal: the registration sitting on the
 * directory, whether any of its sessions runs, and the sessions the removal
 * archives (visible ones: not archived, not blank, not subagent rows).
 * @param path - worktree directory.
 * @param workspaces - live workspace rows.
 * @param sessionOf - session summary lookup.
 * @param archived - archived session ids.
 */
export function removalFactsOf(
  path: string,
  workspaces: readonly WorkspaceLike[],
  sessionOf: (sessionId: string) => SessionLike | undefined,
  archived: ReadonlySet<string>,
): RemovalFacts {
  const workspace = workspaces.find(item => pathKey(item.path) === pathKey(path))
  if (workspace === undefined) return { running: false, workspaceId: undefined, archiveSessionIds: [] }
  let running = false
  const archiveSessionIds: string[] = []
  for (const sessionId of workspace.sessionIds) {
    const summary = sessionOf(sessionId)
    if (summary === undefined) continue
    if (summary.running) running = true
    if (summary.blank || summary.origin === 'subagent') continue
    if (!archived.has(sessionId)) archiveSessionIds.push(sessionId)
  }
  return { running, workspaceId: workspace.workspaceId, archiveSessionIds }
}

/**
 * The workspace registered on a directory, if any.
 * @param path - directory.
 * @param workspaces - live workspace rows.
 */
export function workspaceAt<T extends WorkspaceLike>(path: string, workspaces: readonly T[]): T | undefined {
  return workspaces.find(item => pathKey(item.path) === pathKey(path))
}
