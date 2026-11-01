/**
 * Injected business faces: framework actions the components themselves cannot
 * reach (workspace registration, session navigation, snapshots). Session
 * identity and the list snapshots ride the standard kit (`sessionId`,
 * `useSessions`, ...) that ui-session / ui-conversation merge onto
 * session-scoped slots.
 */

import type { CleanupOutcome, RemovalFacts, RemovalOutcome, RemovalTarget } from './flows.ts'

/** How a new worktree is named. */
export type NamingMode = 'manual' | 'auto'

/** Operations the merge / delete dialogs and the manager list share. */
export interface WorktreeOps {
  /** DSH-side facts of removing the worktree at `path`. */
  removalFacts(path: string): RemovalFacts
  /** The shared removal flow (git first, then archives and unregistration). */
  removeFully(target: RemovalTarget): Promise<RemovalOutcome>
  /**
   * Clean up after a merge. `inside` is true when the current view sits in
   * the worktree: the flow then navigates to the main workspace first.
   */
  cleanupAfterMerge(target: RemovalTarget, inside: boolean): Promise<CleanupOutcome>
  /** Navigate to a blank session of the repository's main workspace (registering it when needed). */
  leaveWorktree(repoRoot: string): void
  /** The model route of a session, for the AI squash draft. */
  modelRoute(sessionId: string | undefined): { provider: string; model: string; effort?: string } | undefined
  /** The cleanup switches from the settings document. */
  settings(): { autoCleanup: boolean; deleteBranchOnCleanup: boolean }
  /** Rename the workspace registered on a directory; resolves false when none is. */
  renameWorkspace(path: string, title: string): Promise<boolean>
  /** Current workspace title of a directory, if registered. */
  workspaceTitle(path: string): string | undefined
  /** The UI language for generated copy. */
  locale(): 'zh' | 'en'
}

/** Injected into the hero chips (dock entry). */
export interface ChipsInjected extends WorktreeOps {
  namingMode(): NamingMode
  /**
   * Register a created worktree as a Workspace, title it, and open a blank
   * session there carrying the typed draft.
   */
  adoptWorktree(input: { path: string; title: string; draft: string }): Promise<void>
  /**
   * Take the draft the previous session handed over for this session, once.
   * Returns undefined when nothing is pending.
   */
  takePendingDraft(sessionId: string): string | undefined
}

/** Injected into the header actions. */
export type HeaderInjected = WorktreeOps
