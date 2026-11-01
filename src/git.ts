/**
 * Git layer of the host half. Every git call goes through one injectable
 * `exec` seam; the functions below are argument assembly plus porcelain
 * parsing and the worktree / merge / cleanup workflows built on top.
 *
 * A worktree is "managed" when the plugin created it: its branch carries the
 * git config key `branch.<name>.dsh-worktree-base` holding the base branch.
 * Worktrees created by other tools never carry the key and are left alone.
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { copyIntoWorktree } from './copy-files.js'
import { localBranchName, nameIssue, sanitizeDirName, shortCodeName, worktreeTitle } from './normalize.js'
import type {
  BranchInfo, CreateResult, ErrorCode, MainCheckout, ManagedInfo, MergeResult, MergeStrategy, RemoveResult, RepoStatus, RouteError, WorktreeEntry,
} from './wire.js'

/** One process result as the seam reports it. */
export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** Node-level failure text when the process never produced stderr. */
  errorMessage?: string
}

/**
 * Process executor seam: runs `file args` in `cwd`, captures UTF-8 output and
 * never throws — a non-zero exit is a normal result.
 */
export type Exec = (file: string, args: readonly string[], options: { cwd: string; timeoutMs?: number }) => Promise<ExecResult>

/** Default hard timeout of one local git call. */
export const GIT_TIMEOUT_MS = 20_000
/** Budget of calls that may run hooks (commit / merge). */
export const HOOK_TIMEOUT_MS = 120_000

/** Real executor over node:child_process with a hard timeout. */
export const childProcessExec: Exec = (file, args, options) => new Promise((resolvePromise) => {
  execFile(file, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
    resolvePromise({
      code,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      ...(error instanceof Error ? { errorMessage: error.message } : {}),
    })
  })
})

/** Failure of one git invocation: non-zero exit with the diagnostic text. */
export class GitError extends Error {
  constructor(readonly args: readonly string[], readonly code: number, readonly stderr: string) {
    super(stderr.trim() === '' ? `git ${args.join(' ')} failed (exit ${String(code)})` : stderr.trim())
    this.name = 'GitError'
  }
}

/** A domain failure with a stable code the client branches on. */
export class WtError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly extra: Pick<RouteError, 'count' | 'files' | 'current'> = {},
  ) {
    super(message)
    this.name = 'WtError'
  }
}

/** Run one git command; a non-zero exit raises {@link GitError}. */
export async function git(exec: Exec, cwd: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  const result = await exec('git', args, { cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  if (result.code !== 0) {
    const diagnostic = result.stderr.trim() !== ''
      ? result.stderr
      : result.stdout.trim() !== ''
        ? result.stdout
        : result.errorMessage ?? 'git produced no diagnostic output'
    throw new GitError(args, result.code, diagnostic)
  }
  return result.stdout
}

/** Run one git command, mapping a non-zero exit to undefined. */
export async function gitMaybe(exec: Exec, cwd: string, args: readonly string[], timeoutMs?: number): Promise<string | undefined> {
  const result = await exec('git', args, { cwd, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  return result.code === 0 ? result.stdout : undefined
}

/** Canonical form of a path for comparisons (symlink-resolved when it exists). */
export async function canon(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** One `git worktree list --porcelain` record. */
export interface WorktreeRecord {
  path: string
  /** Short branch name; undefined on a detached HEAD or a bare entry. */
  branch?: string
  bare: boolean
  prunable: boolean
}

/**
 * Parse `git worktree list --porcelain` output.
 * @param text - raw stdout.
 */
export function parseWorktreeList(text: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(line => line !== '')
    const head = lines.find(line => line.startsWith('worktree '))
    if (head === undefined) continue
    const branchLine = lines.find(line => line.startsWith('branch '))
    const branch = branchLine?.slice('branch '.length).replace(/^refs\/heads\//, '')
    records.push({
      path: head.slice('worktree '.length),
      ...(branch === undefined ? {} : { branch }),
      bare: lines.includes('bare'),
      prunable: lines.some(line => line === 'prunable' || line.startsWith('prunable ')),
    })
  }
  return records
}

/** Everything one repository probe learns. */
export interface RepoProbe {
  /** Main checkout directory (first worktree record). */
  repoRoot: string
  repoName: string
  /** The queried directory's own toplevel. */
  toplevel: string
  /** Whether the queried directory is the main checkout. */
  main: boolean
  currentBranch?: string
  records: WorktreeRecord[]
}

/**
 * Probe the repository behind a directory.
 * @param exec - process seam.
 * @param cwd - any directory inside the repository.
 * @returns the facts, or undefined for a missing / non-git / bare directory.
 */
export async function probeRepo(exec: Exec, cwd: string): Promise<RepoProbe | undefined> {
  if (!existsSync(cwd)) return undefined
  const top = await gitMaybe(exec, cwd, ['rev-parse', '--show-toplevel'])
  if (top === undefined || top.trim() === '') return undefined
  const listing = await gitMaybe(exec, cwd, ['worktree', 'list', '--porcelain'])
  if (listing === undefined) return undefined
  const records = parseWorktreeList(listing)
  const first = records[0]
  if (first === undefined || first.bare) return undefined
  const toplevel = top.trim()
  const topCanon = await canon(toplevel)
  let current: WorktreeRecord | undefined
  for (const record of records) {
    if (await canon(record.path) === topCanon) {
      current = record
      break
    }
  }
  const mainCanon = await canon(first.path)
  return {
    repoRoot: first.path,
    repoName: basename(first.path),
    toplevel,
    main: mainCanon === topCanon,
    ...(current?.branch === undefined ? {} : { currentBranch: current.branch }),
    records,
  }
}

/** Config key holding the base branch of a managed worktree branch. */
export function baseConfigKey(branch: string): string {
  return `branch.${branch}.dsh-worktree-base`
}

/** The recorded base branch of a branch, or undefined when it is not managed. */
export async function managedBase(exec: Exec, repoRoot: string, branch: string): Promise<string | undefined> {
  const value = await gitMaybe(exec, repoRoot, ['config', '--get', baseConfigKey(branch)])
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** Number of uncommitted entries (tracked changes and untracked files). */
export async function dirtyCount(exec: Exec, cwd: string): Promise<number> {
  const out = await git(exec, cwd, ['status', '--porcelain', '--untracked-files=normal'])
  return out.split(/\r?\n/).filter(line => line.trim() !== '').length
}

/** Whether a fully qualified ref exists. */
export async function refExists(exec: Exec, cwd: string, ref: string): Promise<boolean> {
  const result = await exec('git', ['show-ref', '--verify', '--quiet', ref], { cwd })
  return result.code === 0
}

/** List local and remote-only branches with occupancy facts. */
async function listBranches(exec: Exec, probe: RepoProbe): Promise<BranchInfo[]> {
  const out = await git(exec, probe.repoRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes'])
  const locals: string[] = []
  const remotes: string[] = []
  for (const ref of out.split(/\r?\n/)) {
    if (ref.startsWith('refs/heads/')) locals.push(ref.slice('refs/heads/'.length))
    else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length)
      if (!name.endsWith('/HEAD') && name.includes('/')) remotes.push(name)
    }
  }
  const topCanon = await canon(probe.toplevel)
  const occupied = new Map<string, string>()
  for (const record of probe.records) {
    if (record.branch === undefined) continue
    if (await canon(record.path) === topCanon) continue
    occupied.set(record.branch, record.path)
  }
  const localSet = new Set(locals)
  const entries: BranchInfo[] = locals.map(name => ({
    name,
    remote: false,
    current: name === probe.currentBranch,
    ...(occupied.has(name) ? { occupiedBy: occupied.get(name) as string } : {}),
  }))
  for (const name of remotes) {
    if (localSet.has(localBranchName(name))) continue
    entries.push({ name, remote: true, current: false })
  }
  return entries
}

/**
 * Repository status of one directory.
 * @param exec - process seam.
 * @param cwd - directory to describe.
 */
export async function repoStatus(exec: Exec, cwd: string): Promise<RepoStatus> {
  const probe = await probeRepo(exec, cwd)
  if (probe === undefined) return { repo: false }
  const dirty = await dirtyCount(exec, probe.toplevel)
  let managed: ManagedInfo | undefined
  if (!probe.main && probe.currentBranch !== undefined) {
    const base = await managedBase(exec, probe.repoRoot, probe.currentBranch)
    if (base !== undefined) managed = { branch: probe.currentBranch, base }
  }
  let mainCheckout: MainCheckout | undefined
  if (!probe.main) {
    const mainBranch = probe.records[0]?.branch
    mainCheckout = {
      path: probe.repoRoot,
      ...(mainBranch === undefined ? {} : { branch: mainBranch }),
      dirty: await dirtyCount(exec, probe.repoRoot),
    }
  }
  return {
    repo: true,
    repoRoot: probe.repoRoot,
    repoName: probe.repoName,
    toplevel: probe.toplevel,
    main: probe.main,
    ...(probe.currentBranch === undefined ? {} : { currentBranch: probe.currentBranch }),
    dirty,
    ...(managed === undefined ? {} : { managed }),
    ...(mainCheckout === undefined ? {} : { mainCheckout }),
    branches: await listBranches(exec, probe),
  }
}

/**
 * Switch the queried checkout to another branch. Refuses on any uncommitted
 * entry and on a branch another worktree already has checked out.
 * @param exec - process seam.
 * @param cwd - checkout directory.
 * @param branch - local branch or `<remote>/<name>` of a remote-only branch.
 */
export async function switchBranch(exec: Exec, cwd: string, branch: string): Promise<string> {
  const probe = await probeRepo(exec, cwd)
  if (probe === undefined) throw new WtError('not a git repository', 'notRepo')
  const count = await dirtyCount(exec, probe.toplevel)
  if (count > 0) throw new WtError(`${String(count)} uncommitted change(s); commit or stash before switching`, 'dirty', { count })
  if (await refExists(exec, probe.repoRoot, `refs/heads/${branch}`)) {
    const topCanon = await canon(probe.toplevel)
    for (const record of probe.records) {
      if (record.branch === branch && await canon(record.path) !== topCanon) {
        throw new WtError(`branch "${branch}" is checked out in ${record.path}`, 'occupied')
      }
    }
    await git(exec, probe.toplevel, ['switch', branch])
    return branch
  }
  if (await refExists(exec, probe.repoRoot, `refs/remotes/${branch}`)) {
    const local = localBranchName(branch)
    await git(exec, probe.toplevel, ['switch', '--track', '-c', local, branch])
    return local
  }
  throw new WtError(`unknown branch "${branch}"`, 'baseMissing')
}

/** Input of {@link createWorktree}. */
export interface CreateInput {
  cwd: string
  name?: string
  base: string
  /** Absolute storage root. */
  root: string
  /** Configured copy list (merged with `.worktreeinclude`). */
  copyFiles: readonly string[]
  /** Random bytes seam for the auto name. */
  random?: (size: number) => Uint8Array
}

/**
 * Create one managed worktree on a new branch cut from `base`.
 * @param exec - process seam.
 * @param input - creation request.
 */
export async function createWorktree(exec: Exec, input: CreateInput): Promise<CreateResult> {
  const probe = await probeRepo(exec, input.cwd)
  if (probe === undefined) throw new WtError('not a git repository', 'notRepo')
  const random = input.random ?? ((size: number) => randomBytes(size))

  let name = input.name?.trim()
  if (name === undefined || name === '') {
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = shortCodeName(random(8))
      if (!(await refExists(exec, probe.repoRoot, `refs/heads/${candidate}`))) {
        name = candidate
        break
      }
    }
    if (name === undefined || name === '') throw new WtError('could not generate a free worktree name', 'invalidName')
  } else if (nameIssue(name) !== null) {
    throw new WtError(`"${name}" is not a valid worktree name`, 'invalidName')
  }
  if (await refExists(exec, probe.repoRoot, `refs/heads/${name}`)) {
    throw new WtError(`branch "${name}" already exists`, 'branchExists')
  }

  const base = input.base.trim()
  const isLocal = await refExists(exec, probe.repoRoot, `refs/heads/${base}`)
  const isRemote = !isLocal && await refExists(exec, probe.repoRoot, `refs/remotes/${base}`)
  if (!isLocal && !isRemote) throw new WtError(`base branch "${base}" does not exist`, 'baseMissing')
  const baseLocal = isLocal ? base : localBranchName(base)

  const slot = sanitizeDirName(name)
  const parent = join(input.root, probe.repoName)
  let dir = join(parent, slot)
  for (let suffix = 2; existsSync(dir) && suffix < 200; suffix++) dir = join(parent, `${slot}-${String(suffix)}`)
  if (existsSync(dir)) throw new WtError(`no free directory under ${parent}`, 'invalidName')
  await mkdir(parent, { recursive: true })

  await git(exec, probe.repoRoot, ['worktree', 'add', '--no-track', '-b', name, dir, isLocal ? `refs/heads/${base}` : `refs/remotes/${base}`], HOOK_TIMEOUT_MS)
  try {
    await git(exec, probe.repoRoot, ['config', baseConfigKey(name), baseLocal])
  } catch (error) {
    await exec('git', ['worktree', 'remove', '--force', dir], { cwd: probe.repoRoot })
    await exec('git', ['branch', '-D', name], { cwd: probe.repoRoot })
    throw error
  }
  const copy = await copyIntoWorktree(probe.repoRoot, dir, input.copyFiles)
  return {
    path: dir,
    branch: name,
    base: baseLocal,
    repoName: probe.repoName,
    title: worktreeTitle(probe.repoName, name),
    copied: copy.copied,
    copyWarnings: copy.warnings,
  }
}

/** A resolved managed worktree. */
interface Managed {
  probe: RepoProbe
  record: WorktreeRecord
  branch: string
  base: string
  missing: boolean
}

/** Resolve a path to a managed linked worktree or raise `notManaged`. */
async function resolveManaged(exec: Exec, path: string, repoRootHint?: string): Promise<Managed> {
  const origin = existsSync(path) ? path : repoRootHint
  if (origin === undefined) throw new WtError(`"${path}" is not a managed worktree`, 'notManaged')
  const probe = await probeRepo(exec, origin)
  if (probe === undefined) throw new WtError('not a git repository', 'notRepo')
  const wanted = await canon(path)
  let record: WorktreeRecord | undefined
  for (const candidate of probe.records) {
    if (await canon(candidate.path) === wanted) {
      record = candidate
      break
    }
  }
  const mainCanon = await canon(probe.repoRoot)
  if (record === undefined || wanted === mainCanon || record.branch === undefined) {
    throw new WtError(`"${path}" is not a managed worktree`, 'notManaged')
  }
  const base = await managedBase(exec, probe.repoRoot, record.branch)
  if (base === undefined) throw new WtError(`"${path}" was not created by this plugin`, 'notManaged')
  return { probe, record, branch: record.branch, base, missing: record.prunable || !existsSync(record.path) }
}

/** Number of commits `branch` has beyond `base` (0 when `base` is gone). */
async function aheadCount(exec: Exec, repoRoot: string, base: string, branch: string): Promise<number> {
  const out = await gitMaybe(exec, repoRoot, ['rev-list', '--count', `refs/heads/${base}..refs/heads/${branch}`])
  const parsed = Number.parseInt(out?.trim() ?? '', 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Whether git sees `branch` merged into `base`. */
async function isMerged(exec: Exec, repoRoot: string, base: string, branch: string): Promise<boolean> {
  const result = await exec('git', ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${base}`], { cwd: repoRoot })
  return result.code === 0
}

/** Build the list entry of one managed worktree. */
async function entryOf(exec: Exec, managed: Managed): Promise<WorktreeEntry> {
  const { probe, record, branch, base, missing } = managed
  return {
    path: record.path,
    repoRoot: probe.repoRoot,
    repoName: probe.repoName,
    branch,
    base,
    ahead: await aheadCount(exec, probe.repoRoot, base, branch),
    dirty: missing ? 0 : await dirtyCount(exec, record.path),
    merged: await isMerged(exec, probe.repoRoot, base, branch),
    missing,
  }
}

/** Facts of one managed worktree. */
export async function inspectWorktree(exec: Exec, path: string, repoRootHint?: string): Promise<WorktreeEntry> {
  return entryOf(exec, await resolveManaged(exec, path, repoRootHint))
}

/** Upper bound of listed worktrees (a runaway repository never floods the page). */
export const LIST_LIMIT = 200

/**
 * List the managed worktrees of every repository behind the given paths.
 * @param exec - process seam.
 * @param paths - workspace directories (missing / non-git ones are skipped).
 */
export async function listManaged(exec: Exec, paths: readonly string[]): Promise<WorktreeEntry[]> {
  const entries: WorktreeEntry[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const probe = await probeRepo(exec, path)
    if (probe === undefined) continue
    const rootKey = await canon(probe.repoRoot)
    if (seen.has(rootKey)) continue
    seen.add(rootKey)
    for (const record of probe.records.slice(1)) {
      if (entries.length >= LIST_LIMIT) return entries
      if (record.branch === undefined) continue
      const base = await managedBase(exec, probe.repoRoot, record.branch)
      if (base === undefined) continue
      entries.push(await entryOf(exec, {
        probe, record, branch: record.branch, base, missing: record.prunable || !existsSync(record.path),
      }))
    }
  }
  return entries
}

/** Input of {@link mergeWorktree}. */
export interface MergeInput {
  path: string
  target?: string
  strategy: MergeStrategy
  message?: string
}

/** Files with unresolved conflicts in `cwd`. */
async function conflictedFiles(exec: Exec, cwd: string): Promise<string[]> {
  const out = await gitMaybe(exec, cwd, ['diff', '--name-only', '--diff-filter=U']) ?? ''
  return out.split(/\r?\n/).filter(line => line !== '')
}

/**
 * Merge a managed worktree's branch into the target branch of the main
 * checkout. Pre-checks refuse a dirty worktree, a main checkout that is not on
 * the target or not clean, and an empty merge; a conflict is rolled back.
 * @param exec - process seam.
 * @param input - merge request.
 */
export async function mergeWorktree(exec: Exec, input: MergeInput): Promise<MergeResult> {
  const managed = await resolveManaged(exec, input.path)
  const { probe, branch } = managed
  const target = input.target?.trim() === undefined || input.target.trim() === '' ? managed.base : input.target.trim()
  if (target === branch || !(await refExists(exec, probe.repoRoot, `refs/heads/${target}`))) {
    throw new WtError(`target branch "${target}" is not available`, 'targetMissing')
  }
  const worktreeDirty = await dirtyCount(exec, managed.record.path)
  if (worktreeDirty > 0) {
    throw new WtError(`the worktree has ${String(worktreeDirty)} uncommitted change(s)`, 'worktreeDirty', { count: worktreeDirty })
  }
  const mainBranch = probe.records[0]?.branch
  if (mainBranch !== target) {
    throw new WtError(`the main checkout is on "${mainBranch ?? 'a detached HEAD'}", not "${target}"`, 'mainNotOnTarget', mainBranch === undefined ? {} : { current: mainBranch })
  }
  const mainDirty = await dirtyCount(exec, probe.repoRoot)
  if (mainDirty > 0) {
    throw new WtError(`the main checkout has ${String(mainDirty)} uncommitted change(s)`, 'mainDirty', { count: mainDirty })
  }
  if (await aheadCount(exec, probe.repoRoot, target, branch) === 0) {
    throw new WtError(`"${branch}" has nothing to merge into "${target}"`, 'nothingToMerge')
  }

  const message = input.message?.trim() ?? ''
  if (input.strategy === 'squash') {
    if (message === '') throw new WtError('a commit message is required for squash', 'messageRequired')
    const result = await exec('git', ['merge', '--squash', branch], { cwd: probe.repoRoot, timeoutMs: HOOK_TIMEOUT_MS })
    if (result.code !== 0) {
      const files = await conflictedFiles(exec, probe.repoRoot)
      await exec('git', ['reset', '--merge'], { cwd: probe.repoRoot })
      if (files.length > 0) throw new WtError(`merge conflict in ${String(files.length)} file(s)`, 'conflict', { files })
      throw new GitError(['merge', '--squash', branch], result.code, result.stderr || result.stdout)
    }
    const staged = await exec('git', ['diff', '--cached', '--quiet'], { cwd: probe.repoRoot })
    if (staged.code === 0) {
      await exec('git', ['reset', '--merge'], { cwd: probe.repoRoot })
      throw new WtError(`"${branch}" has nothing to merge into "${target}"`, 'nothingToMerge')
    }
    const commit = await exec('git', ['commit', '-m', message], { cwd: probe.repoRoot, timeoutMs: HOOK_TIMEOUT_MS })
    if (commit.code !== 0) {
      await exec('git', ['reset', '--merge'], { cwd: probe.repoRoot })
      throw new GitError(['commit'], commit.code, commit.stderr || commit.stdout)
    }
  } else {
    const text = message === '' ? `Merge branch '${branch}'` : message
    const result = await exec('git', ['merge', '--no-ff', '-m', text, branch], { cwd: probe.repoRoot, timeoutMs: HOOK_TIMEOUT_MS })
    if (result.code !== 0) {
      const files = await conflictedFiles(exec, probe.repoRoot)
      await exec('git', ['merge', '--abort'], { cwd: probe.repoRoot })
      if (files.length > 0) throw new WtError(`merge conflict in ${String(files.length)} file(s)`, 'conflict', { files })
      throw new GitError(['merge', branch], result.code, result.stderr || result.stdout)
    }
  }
  const sha = (await git(exec, probe.repoRoot, ['rev-parse', 'HEAD'])).trim()
  return { commit: sha, target, strategy: input.strategy, branch }
}

/** Input of {@link removeManaged}. */
export interface RemoveInput {
  path: string
  repoRoot?: string
  force: boolean
  deleteBranch: boolean
  forceBranch: boolean
}

/**
 * Remove a managed worktree and, on request, its branch.
 * @param exec - process seam.
 * @param input - removal request.
 */
export async function removeManaged(exec: Exec, input: RemoveInput): Promise<RemoveResult> {
  const managed = await resolveManaged(exec, input.path, input.repoRoot)
  const { probe, branch, base, missing } = managed
  if (!missing && !input.force) {
    const count = await dirtyCount(exec, managed.record.path)
    if (count > 0) throw new WtError(`the worktree has ${String(count)} uncommitted change(s)`, 'dirty', { count })
  }
  if (input.deleteBranch && !input.forceBranch && !(await isMerged(exec, probe.repoRoot, base, branch))) {
    throw new WtError(`branch "${branch}" is not merged into "${base}"`, 'unmerged')
  }
  if (missing) {
    await git(exec, probe.repoRoot, ['worktree', 'prune'])
  } else {
    await git(exec, probe.repoRoot, ['worktree', 'remove', ...input.force ? ['--force'] : [], managed.record.path], HOOK_TIMEOUT_MS)
  }
  let branchDeleted = false
  if (input.deleteBranch) {
    await git(exec, probe.repoRoot, ['branch', input.forceBranch ? '-D' : '-d', branch])
    branchDeleted = true
  } else {
    // The branch survives but is no longer a managed worktree branch.
    await exec('git', ['config', '--unset', baseConfigKey(branch)], { cwd: probe.repoRoot })
  }
  return { branch, branchDeleted }
}

/** Inputs the squash-message drafting needs. */
export interface SquashInput {
  subjects: string[]
  base: string
  branch: string
  stat: string
  diff: string
}

/** Bound of the diff handed to the model (characters). */
export const SQUASH_DIFF_LIMIT = 30_000

/**
 * Collect the commit subjects and diff of a managed worktree's branch.
 * @param exec - process seam.
 * @param path - managed worktree directory.
 */
export async function collectSquashInput(exec: Exec, path: string): Promise<SquashInput> {
  const managed = await resolveManaged(exec, path)
  const { probe, branch, base } = managed
  const range = `refs/heads/${base}..refs/heads/${branch}`
  const subjects = (await gitMaybe(exec, probe.repoRoot, ['log', '--reverse', '--format=%s', range]) ?? '')
    .split(/\r?\n/).filter(line => line !== '')
  const stat = await gitMaybe(exec, probe.repoRoot, ['diff', '--stat', `refs/heads/${base}...refs/heads/${branch}`]) ?? ''
  const diff = (await gitMaybe(exec, probe.repoRoot, ['diff', `refs/heads/${base}...refs/heads/${branch}`]) ?? '').slice(0, SQUASH_DIFF_LIMIT)
  return { subjects, base, branch, stat, diff }
}

/**
 * The fallback squash draft: the commit subjects as a bullet list headed by
 * the first subject.
 * @param subjects - commit subjects, oldest first.
 * @param branch - branch name used when there are no subjects.
 */
export function fallbackSquashMessage(subjects: readonly string[], branch: string): string {
  if (subjects.length === 0) return `Merge ${branch}`
  if (subjects.length === 1) return subjects[0] as string
  return `${subjects[0] as string}\n\n${subjects.map(subject => `- ${subject}`).join('\n')}`
}
