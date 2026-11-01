/**
 * Route logic as pure functions: query / body in, status + body out. The HTTP
 * shell (index.ts) owns req / res mechanics; everything testable lives here.
 */

import {
  childProcessExec, collectSquashInput, createWorktree, fallbackSquashMessage, GitError, inspectWorktree, listManaged,
  mergeWorktree, removeManaged, repoStatus, switchBranch, WtError, type Exec,
} from './git.js'
import { isAbsoluteConfigPath } from './normalize.js'
import { resolveRootDir } from './settings.js'
import type {
  CreateBody, CreateResult, InspectBody, InspectResult, ListBody, ListResult, MergeBody, MergeResult, RemoveBody, RemoveResult,
  RepoStatus, RouteError, SquashMessageBody, SquashMessageResult, SwitchBody, SwitchResult,
} from './wire.js'

/** Everything the handlers need from the host half. */
export interface RouteDeps {
  exec: Exec
  /** The settings-resolved rootDir (absent / blank = default). */
  sectionRootDir: () => string | undefined
  /** The configured copy list. */
  sectionCopyFiles: () => string[] | undefined
  /** User home directory seam. */
  home: () => string
  /** `$DSH_HOME` seam. */
  envHome: () => string | undefined
}

/** One route outcome: HTTP status plus the JSON body. */
export interface RouteOutcome {
  status: number
  body: RepoStatus | SwitchResult | CreateResult | ListResult | InspectResult | MergeResult | RemoveResult | SquashMessageResult | RouteError
}

/** Default deps over the real executor (tests substitute fields). */
export function defaultExec(): Exec {
  return childProcessExec
}

function fail(status: number, error: string): RouteOutcome {
  return { status, body: { error } }
}

/** Map a thrown value to the failure envelope. */
export function failure(error: unknown): RouteOutcome {
  if (error instanceof WtError) {
    const body: RouteError = { error: error.message, code: error.code, ...error.extra }
    return { status: error.code === 'notRepo' || error.code === 'invalidName' || error.code === 'messageRequired' ? 400 : 409, body }
  }
  if (error instanceof GitError) return fail(400, error.message)
  return fail(500, error instanceof Error ? error.message : String(error))
}

/** Parse a body object and check string fields. */
function readBody<T>(body: unknown, required: readonly string[], optional: readonly string[] = []): T | RouteOutcome {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'request body must be a JSON object')
  const record = body as Record<string, unknown>
  for (const key of required) {
    if (typeof record[key] !== 'string') return fail(400, `"${key}" must be a string`)
  }
  for (const key of optional) {
    if (record[key] !== undefined && typeof record[key] !== 'string') return fail(400, `"${key}" must be a string`)
  }
  return record as T
}

function isOutcome(value: unknown): value is RouteOutcome {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value
}

function isAbsoluteDir(value: string): boolean {
  return isAbsoluteConfigPath(value) && !value.includes('\u0000')
}

/**
 * GET /status — repository status of one directory.
 * @param deps - host dependencies.
 * @param path - absolute directory (query value).
 */
export async function handleStatus(deps: RouteDeps, path: string | undefined): Promise<RouteOutcome> {
  if (path === undefined || !isAbsoluteDir(path)) return fail(400, '"path" must be an absolute directory')
  try {
    return { status: 200, body: await repoStatus(deps.exec, path) }
  } catch (error) {
    return failure(error)
  }
}

/** POST /switch — switch the branch of the queried checkout. */
export async function handleSwitch(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const parsed = readBody<SwitchBody>(body, ['path', 'branch'])
  if (isOutcome(parsed)) return parsed
  if (!isAbsoluteDir(parsed.path)) return fail(400, '"path" must be an absolute directory')
  if (parsed.branch.trim() === '' || parsed.branch.startsWith('-')) return fail(400, '"branch" is not a valid branch name')
  try {
    const branch = await switchBranch(deps.exec, parsed.path, parsed.branch.trim())
    const result: SwitchResult = { branch }
    return { status: 200, body: result }
  } catch (error) {
    return failure(error)
  }
}

/** POST /create — create one worktree. */
export async function handleCreate(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const parsed = readBody<CreateBody>(body, ['path', 'base'], ['name'])
  if (isOutcome(parsed)) return parsed
  if (!isAbsoluteDir(parsed.path)) return fail(400, '"path" must be an absolute directory')
  if (parsed.base.trim() === '' || parsed.base.startsWith('-')) return fail(400, '"base" is not a valid branch name')
  try {
    const result = await createWorktree(deps.exec, {
      cwd: parsed.path,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      base: parsed.base,
      root: resolveRootDir(deps.sectionRootDir(), deps.home(), deps.envHome()),
      copyFiles: deps.sectionCopyFiles() ?? [],
    })
    return { status: 200, body: result }
  } catch (error) {
    return failure(error)
  }
}

/** POST /list — managed worktrees of the repositories behind some paths. */
export async function handleList(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as ListBody).paths)) return fail(400, '"paths" must be an array')
  const paths = (body as ListBody).paths
  if (!paths.every(item => typeof item === 'string')) return fail(400, '"paths" must be an array of strings')
  try {
    const worktrees = await listManaged(deps.exec, paths.filter(isAbsoluteDir))
    const result: ListResult = { worktrees }
    return { status: 200, body: result }
  } catch (error) {
    return failure(error)
  }
}

/** POST /inspect — facts of one managed worktree. */
export async function handleInspect(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const parsed = readBody<InspectBody>(body, ['path'], ['repoRoot'])
  if (isOutcome(parsed)) return parsed
  if (!isAbsoluteDir(parsed.path)) return fail(400, '"path" must be an absolute directory')
  try {
    const entry = await inspectWorktree(deps.exec, parsed.path, parsed.repoRoot)
    const result: InspectResult = { entry }
    return { status: 200, body: result }
  } catch (error) {
    return failure(error)
  }
}

/** POST /merge — merge one managed worktree into its target branch. */
export async function handleMerge(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const parsed = readBody<MergeBody>(body, ['path', 'strategy'], ['target', 'message'])
  if (isOutcome(parsed)) return parsed
  if (!isAbsoluteDir(parsed.path)) return fail(400, '"path" must be an absolute directory')
  if (parsed.strategy !== 'merge' && parsed.strategy !== 'squash') return fail(400, '"strategy" must be "merge" or "squash"')
  if (parsed.target !== undefined && parsed.target.startsWith('-')) return fail(400, '"target" is not a valid branch name')
  try {
    const result = await mergeWorktree(deps.exec, {
      path: parsed.path,
      strategy: parsed.strategy,
      ...(parsed.target === undefined ? {} : { target: parsed.target }),
      ...(parsed.message === undefined ? {} : { message: parsed.message }),
    })
    return { status: 200, body: result }
  } catch (error) {
    return failure(error)
  }
}

/** POST /remove — remove one managed worktree. */
export async function handleRemove(deps: RouteDeps, body: unknown): Promise<RouteOutcome> {
  const parsed = readBody<RemoveBody>(body, ['path'], ['repoRoot'])
  if (isOutcome(parsed)) return parsed
  const flags = body as Record<string, unknown>
  for (const key of ['force', 'deleteBranch', 'forceBranch']) {
    if (typeof flags[key] !== 'boolean') return fail(400, `"${key}" must be a boolean`)
  }
  if (!isAbsoluteDir(parsed.path)) return fail(400, '"path" must be an absolute directory')
  if (parsed.repoRoot !== undefined && !isAbsoluteDir(parsed.repoRoot)) return fail(400, '"repoRoot" must be an absolute directory')
  try {
    const result = await removeManaged(deps.exec, {
      path: parsed.path,
      ...(parsed.repoRoot === undefined ? {} : { repoRoot: parsed.repoRoot }),
      force: flags['force'] as boolean,
      deleteBranch: flags['deleteBranch'] as boolean,
      forceBranch: flags['forceBranch'] as boolean,
    })
    return { status: 200, body: result }
  } catch (error) {
    return failure(error)
  }
}

/** Narrow face of the host llm runtime the squash drafting needs. */
export interface LlmStreamRuntime {
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: string
    messages: ReadonlyArray<{ role: 'user'; content: ReadonlyArray<{ type: 'text'; text: string }> }>
    system?: string
    temperature?: number
    maxTokens?: number
  }): AsyncIterable<{ type: string; text?: string }>
}

/** Bound of the generated message (characters). */
const AI_MESSAGE_LIMIT = 2000

/**
 * POST /squash-message — draft the squash commit message. Uses the llm when
 * the service and the session's model route are available and silently falls
 * back to the commit-subject list otherwise.
 * @param deps - host dependencies.
 * @param llm - the llm runtime, absent when the host has none.
 * @param body - parsed request body.
 */
export async function handleSquashMessage(deps: RouteDeps, llm: LlmStreamRuntime | undefined, body: unknown): Promise<RouteOutcome> {
  const parsed = readBody<SquashMessageBody>(body, ['path'], ['provider', 'model', 'effort'])
  if (isOutcome(parsed)) return parsed
  if (!isAbsoluteDir(parsed.path)) return fail(400, '"path" must be an absolute directory')
  try {
    const input = await collectSquashInput(deps.exec, parsed.path)
    const fallback = fallbackSquashMessage(input.subjects, input.branch)
    const draft = (message: string, ai: boolean): RouteOutcome => ({
      status: 200,
      body: { subjects: input.subjects, message, ai } satisfies SquashMessageResult,
    })
    if (llm === undefined || parsed.provider === undefined || parsed.model === undefined
      || parsed.provider.trim() === '' || parsed.model.trim() === '' || input.subjects.length === 0) {
      return draft(fallback, false)
    }
    try {
      const userText = [
        `Write ONE git commit message that squashes the ${String(input.subjects.length)} commit(s) of branch "${input.branch}" into "${input.base}".`,
        `Commit subjects (oldest first):\n${input.subjects.map(subject => `- ${subject}`).join('\n')}`,
        `Diff stat:\n${input.stat}`,
        `Diff (may be truncated):\n${input.diff}`,
      ].join('\n\n')
      let text = ''
      for await (const chunk of llm.stream({
        provider: parsed.provider,
        model: parsed.model,
        ...(parsed.effort === undefined || parsed.effort === '' ? {} : { reasoningEffort: parsed.effort }),
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        system: 'You write git commit messages. Reply with the message ONLY: one subject line (match the language of the commit subjects), optionally followed by a blank line and a short bullet list. No explanations, no markdown fences.',
        temperature: 0.2,
        maxTokens: 500,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text ?? ''
      }
      text = text.replace(/^```[a-z]*\n?|```\n?$/g, '').trim().slice(0, AI_MESSAGE_LIMIT)
      return text === '' ? draft(fallback, false) : draft(text, true)
    } catch {
      return draft(fallback, false)
    }
  } catch (error) {
    return failure(error)
  }
}
