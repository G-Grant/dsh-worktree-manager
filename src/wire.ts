/**
 * Wire contract shared by the host routes and the browser client: route
 * paths, request bodies and result shapes. Type-only apart from the route
 * constants, so the browser bundle can import it without Node.
 */

/** Route prefix of every endpoint of this plugin (independent from other git plugins). */
export const ROUTE_PREFIX = '/plugin/worktree-manager'

/** GET ROUTE_STATUS?path=<absolute dir> — repository facts of one directory. */
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`
/** POST ROUTE_SWITCH — switch the branch of the queried checkout in place. */
export const ROUTE_SWITCH = `${ROUTE_PREFIX}/switch`
/** POST ROUTE_CREATE — create one worktree. */
export const ROUTE_CREATE = `${ROUTE_PREFIX}/create`
/** POST ROUTE_LIST — every managed worktree of the repositories behind some paths. */
export const ROUTE_LIST = `${ROUTE_PREFIX}/list`
/** POST ROUTE_INSPECT — facts of one managed worktree. */
export const ROUTE_INSPECT = `${ROUTE_PREFIX}/inspect`
/** POST ROUTE_MERGE — merge one managed worktree into its target branch. */
export const ROUTE_MERGE = `${ROUTE_PREFIX}/merge`
/** POST ROUTE_REMOVE — remove one managed worktree (and optionally its branch). */
export const ROUTE_REMOVE = `${ROUTE_PREFIX}/remove`
/** POST ROUTE_SQUASH_MESSAGE — draft the squash commit message. */
export const ROUTE_SQUASH_MESSAGE = `${ROUTE_PREFIX}/squash-message`

/** Stable error codes the client branches on. */
export type ErrorCode =
  | 'notRepo'
  | 'branchExists'
  | 'baseMissing'
  | 'invalidName'
  | 'dirty'
  | 'occupied'
  | 'notManaged'
  | 'worktreeDirty'
  | 'mainNotOnTarget'
  | 'mainDirty'
  | 'nothingToMerge'
  | 'conflict'
  | 'unmerged'
  | 'messageRequired'
  | 'targetMissing'
  | 'fetchFailed'

/** Uniform failure envelope. */
export interface RouteError {
  error: string
  code?: ErrorCode
  /** Uncommitted entry count (`dirty`, `worktreeDirty`, `mainDirty`). */
  count?: number
  /** Conflicting files (`conflict`). */
  files?: string[]
  /** The branch the main checkout actually sits on (`mainNotOnTarget`). */
  current?: string
}

/** One selectable branch. */
export interface BranchInfo {
  /** Display name: `feat-x` for a local branch, `origin/feat-x` for a remote-only one. */
  name: string
  remote: boolean
  current: boolean
  /** Worktree directory that already has this branch checked out (never the queried one). */
  occupiedBy?: string
}

/** Facts of a managed (plugin-created) linked worktree. */
export interface ManagedInfo {
  branch: string
  base: string
}

/** The main checkout as seen from a linked worktree (merge pre-check facts). */
export interface MainCheckout {
  path: string
  /** Checked-out branch; undefined on a detached HEAD. */
  branch?: string
  /** Uncommitted entry count. */
  dirty: number
}

/** Repository status of one directory. */
export type RepoStatus =
  | { repo: false }
  | {
    repo: true
    repoRoot: string
    repoName: string
    /** The queried directory's own toplevel. */
    toplevel: string
    /** Whether the queried directory is the main checkout. */
    main: boolean
    /** Checked-out branch; undefined on a detached HEAD. */
    currentBranch?: string
    /** Uncommitted entry count of the queried checkout. */
    dirty: number
    /** Set when the queried directory is a managed linked worktree. */
    managed?: ManagedInfo
    /** Facts of the main checkout, present when the queried directory is a linked worktree. */
    mainCheckout?: MainCheckout
    branches: BranchInfo[]
  }

export interface SwitchBody {
  path: string
  branch: string
}
export interface SwitchResult {
  branch: string
}

export interface CreateBody {
  /** The session directory (main checkout or any worktree of the repository). */
  path: string
  /** Wanted name; absent = generate `wt-xxxxxx`. */
  name?: string
  /** Base branch (display name, local or `<remote>/<name>`). */
  base: string
}
export interface CreateResult {
  path: string
  branch: string
  base: string
  repoName: string
  title: string
  /** Files copied into the new worktree. */
  copied: string[]
  /** Copy entries that were skipped with the reason (never fatal). */
  copyWarnings: string[]
}

export interface ListBody {
  /** Workspace directories; every repository behind them is scanned. */
  paths: string[]
}
export interface WorktreeEntry {
  path: string
  repoRoot: string
  repoName: string
  branch: string
  base: string
  /** Commits on the branch not yet in the base. */
  ahead: number
  /** Uncommitted entries (0 when the directory is missing). */
  dirty: number
  /** Whether git considers the branch merged into the base. */
  merged: boolean
  /** Directory is gone or git marks the registration prunable. */
  missing: boolean
}
export interface ListResult {
  worktrees: WorktreeEntry[]
}

export interface InspectBody {
  path: string
  repoRoot?: string
}
export interface InspectResult {
  entry: WorktreeEntry
}

export type MergeStrategy = 'merge' | 'squash'
export interface MergeBody {
  /** The managed worktree directory. */
  path: string
  /** Target branch; absent = the recorded base branch. */
  target?: string
  strategy: MergeStrategy
  /** Commit message (required for squash; default for merge). */
  message?: string
}
export interface MergeResult {
  commit: string
  target: string
  strategy: MergeStrategy
  branch: string
}

export interface RemoveBody {
  path: string
  /** Needed when the worktree directory is gone. */
  repoRoot?: string
  /** Remove despite uncommitted changes. */
  force: boolean
  deleteBranch: boolean
  /** Delete the branch with -D even when git does not see it merged. */
  forceBranch: boolean
}
export interface RemoveResult {
  branch: string
  branchDeleted: boolean
}

export interface SquashMessageBody {
  path: string
  /** Model route of the requesting session (optional: absent = no AI). */
  provider?: string
  model?: string
  effort?: string
}
export interface SquashMessageResult {
  /** Commit subjects of the branch, oldest first. */
  subjects: string[]
  /** The draft message: AI summary when available, otherwise the subject list. */
  message: string
  /** Whether `message` came from the model. */
  ai: boolean
}
