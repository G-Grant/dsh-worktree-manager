/**
 * dsh-worktree-manager host half. Exposes the configuration fields projected
 * through the settings service (the `dsh-worktree-manager` profile entry) and,
 * while a webServer service exists, the HTTP routes the browser half calls.
 * Config edits persist into the profile patch and take effect live.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context declaration merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the settings Context declaration merge (`ctx.settings`).
import type {} from '@deepseek-ai/dsh-settings'
import { childProcessExec } from './git.js'
import {
  handleCreate, handleInspect, handleList, handleMerge, handleRemove, handleSquashMessage, handleStatus, handleSwitch,
  type LlmStreamRuntime, type RouteDeps, type RouteOutcome,
} from './routes.js'
import { isSafeRelativePath } from './normalize.js'
import {
  ROUTE_CREATE, ROUTE_INSPECT, ROUTE_LIST, ROUTE_MERGE, ROUTE_REMOVE, ROUTE_SQUASH_MESSAGE, ROUTE_STATUS, ROUTE_SWITCH,
} from './wire.js'

export const name = 'dsh-worktree-manager'

export const inject = []

/** Largest accepted request body (bytes). */
const BODY_LIMIT = 64 * 1024

/** How a new worktree gets its name. */
export type NamingMode = 'manual' | 'auto'

function readVolatile<T>(value: Volatile<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && 'get' in value && typeof (value as { get: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

export interface Config {
  /** `manual` (default): the user types the name; `auto`: a short code `wt-xxxxxx`. */
  namingMode?: Volatile<NamingMode> | NamingMode
  /** Clean up the worktree after a successful merge; absent = on. */
  autoCleanup?: Volatile<boolean> | boolean
  /** Also delete the branch during cleanup; absent = on. */
  deleteBranchOnCleanup?: Volatile<boolean> | boolean
  /** Fetch the base branch's remote before creating a worktree; absent = on. */
  fetchBaseBeforeCreate?: Volatile<boolean> | boolean
  /** Extra files copied into every new worktree (besides `.worktreeinclude`). */
  copyFiles?: Volatile<string[]> | string[]
}

/**
 * Cordis resolves the composition entry's config through this schema before
 * `apply` runs. Fields marked `.volatile()` are projected live into the
 * configuration forms by the settings service.
 */
export const Config: z = z.object({
  namingMode: z.union([z.const('manual'), z.const('auto')]).default('manual').volatile(),
  autoCleanup: z.boolean().default(true).volatile(),
  deleteBranchOnCleanup: z.boolean().default(true).volatile(),
  fetchBaseBeforeCreate: z.boolean().default(true).volatile(),
  copyFiles: z.array(z.string()).default([]).volatile(),
})

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  // rootDir is ignored: leftover from when storage was configurable.
  'rootDir', 'namingMode', 'autoCleanup', 'deleteBranchOnCleanup', 'fetchBaseBeforeCreate', 'copyFiles',
])

/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config: Config): void {
  const unknown = Object.keys(config).find(key => !KNOWN_KEYS.has(key))
  if (unknown !== undefined) throw new Error(`WorktreeManagerConfig: unknown key "${unknown}"`)
  const mode = readVolatile(config.namingMode)
  if (mode !== undefined && mode !== 'manual' && mode !== 'auto') {
    throw new Error('WorktreeManagerConfig: "namingMode" must be "manual" or "auto"')
  }
  for (const key of ['autoCleanup', 'deleteBranchOnCleanup', 'fetchBaseBeforeCreate'] as const) {
    const value = readVolatile(config[key])
    if (value !== undefined && typeof value !== 'boolean') throw new Error(`WorktreeManagerConfig: "${key}" must be a boolean`)
  }
  const copyFiles = readVolatile(config.copyFiles)
  if (copyFiles !== undefined) {
    if (!Array.isArray(copyFiles) || !copyFiles.every(item => typeof item === 'string')) {
      throw new Error('WorktreeManagerConfig: "copyFiles" must be an array of strings')
    }
    const bad = copyFiles.find(item => item.trim() !== '' && !isSafeRelativePath(item))
    if (bad !== undefined) throw new Error(`WorktreeManagerConfig: "copyFiles" entry "${bad}" is not a safe relative path`)
  }
}

/** The settings namespace this plugin serves; its browser card spells the same string. */
export const WORKTREE_MANAGER_NS = 'worktree-manager'

/**
 * Plugin apply: mount the settings presentation policy and the HTTP routes on
 * any webServer that comes and goes.
 * @param ctx - host cordis context.
 * @param config - the composition entry config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  validateConfig(config)

  const currentConfig = (): Config => (ctx.fiber?.config as Config | undefined) ?? config

  const deps = (): RouteDeps => ({
    exec: childProcessExec,
    sectionCopyFiles: () => readVolatile(currentConfig().copyFiles),
    sectionFetchBase: () => readVolatile(currentConfig().fetchBaseBeforeCreate),
  })

  // The plugin ships its own configuration card (`plugins.bundle.config`), so
  // the settings service must not auto-project a second form.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber), 'worktree-manager: settings presentation policy')
  })

  ctx.inject(['webServer'], (webCtx) => {
    const send = (res: ServerResponse, outcome: RouteOutcome): void => {
      res.writeHead(outcome.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(outcome.body))
    }

    const readJson = (req: IncomingMessage): Promise<unknown> => new Promise((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > BODY_LIMIT) {
          req.destroy()
          rejectPromise(new Error('request body too large'))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) {
          resolvePromise({})
          return
        }
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          rejectPromise(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
        }
      })
      req.on('error', rejectPromise)
    })

    /** One exact POST route: bounded JSON body in, one RouteOutcome out. */
    const postRoute = (path: string, label: string, handle: (deps: RouteDeps, body: unknown) => Promise<RouteOutcome>): void => {
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          send(res, await handle(deps(), await readJson(req)))
        } catch (error) {
          send(res, { status: 400, body: { error: error instanceof Error ? error.message : String(error) } })
        }
      } }), `worktree-manager: ${label} route`)
    }

    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: ROUTE_STATUS, handler: async (req: IncomingMessage, res: ServerResponse) => {
      /* v8 ignore next -- node:http always sets url on server requests. */
      const query = new URL(req.url ?? '/', 'http://x').searchParams
      send(res, await handleStatus(deps(), query.get('path') ?? undefined))
    } }), 'worktree-manager: status route')

    postRoute(ROUTE_SWITCH, 'switch', handleSwitch)
    postRoute(ROUTE_CREATE, 'create', handleCreate)
    postRoute(ROUTE_LIST, 'list', handleList)
    postRoute(ROUTE_INSPECT, 'inspect', handleInspect)
    postRoute(ROUTE_MERGE, 'merge', handleMerge)
    postRoute(ROUTE_REMOVE, 'remove', handleRemove)

    // The squash draft works with or without the llm service: without one it
    // answers the commit-subject list. The llm injection only upgrades it.
    let llm: LlmStreamRuntime | undefined
    ctx.inject(['llm'], (llmCtx) => {
      llm = (llmCtx as unknown as { llm: LlmStreamRuntime }).llm
      llmCtx.effect(() => () => { llm = undefined }, 'worktree-manager: llm handle')
    })
    postRoute(ROUTE_SQUASH_MESSAGE, 'squash-message', (routeDeps, body) => handleSquashMessage(routeDeps, llm, body))
  })
}
