/**
 * dsh-worktree-manager browser half. Registers three slot entries:
 *
 *  - `conversation.input.dock` — the hero chips (branch / environment) of a
 *    blank session in a repository's main checkout (see WorktreeChips);
 *  - `conversation.session.header.actions` — merge / delete of a managed
 *    worktree session;
 *  - `plugins.bundle.config` — the configuration form plus the worktree
 *    manager list on the Plugins page.
 *
 * Repo facts and every git action flow through the host half's routes;
 * workspace registration and session navigation go through the framework's
 * `workspaces` and `uiWorkspace` services.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: merge the service / slot declarations this package relies on.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { requestRemove } from './api.ts'
import { CardForm, type SectionValue } from './card-form.ts'
import { ConfigCard } from './ConfigCard.tsx'
import { removalFactsOf, workspaceAt } from './facts.ts'
import { cleanupAfterMerge, removeWorktreeFully, unwrap, type RemovalDeps } from './flows.ts'
import { HeaderActions } from './HeaderActions.tsx'
import { en, zh, type WorktreeKey } from './locales.ts'
import type { ManagerFace } from './ManagerList.tsx'
import type { ChipsInjected, HeaderInjected, NamingMode, WorktreeOps } from './slots.ts'
import { WorktreeChips } from './WorktreeChips.tsx'

export type { WorktreeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The chips, dialogs and configuration card copy. */
    'worktree-manager': WorktreeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'worktree-manager'

/** Host composition entry id from cordis.patch.yml (the configuration form key). */
const PLUGIN_ENTRY_ID = 'dsh-worktree-manager'

/** This package's own name: the key `plugins.bundle.config` dispatches by. */
const PLUGIN_PACKAGE = 'dsh-worktree-manager'

/** Required services: the slot ledger, session / workspace runtimes, the
 * workspace navigation face, copy, and the config forms behind the card. */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale', 'configForms']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'worktree-manager: dictionaries')

  const settingsForm = ctx.configForms.get<SectionValue>(PLUGIN_ENTRY_ID)

  /** Drafts handed from the session a worktree was created in to the new one. */
  const pendingDrafts = new Map<string, string>()

  const removalFacts: WorktreeOps['removalFacts'] = (path) => {
    const workspaces = ctx.workspaces.list.getSnapshot()
    const sessions = ctx.sessions.list.getSnapshot()
    return removalFactsOf(
      path,
      workspaces.items.map(item => ({ workspaceId: item.workspaceId as string, path: item.path, sessionIds: item.sessionIds as readonly string[] })),
      (sessionId) => {
        const summary = sessions.byId[sessionId as SessionId]
        if (summary === undefined) return undefined
        return { running: summary.running, blank: summary.blank, ...(summary.origin === 'subagent' ? { origin: 'subagent' } : {}) }
      },
      new Set<string>(workspaces.archivedSessionIds),
    )
  }

  const removalDeps: RemovalDeps = {
    removeWorktree: async input => unwrap(await requestRemove(input)),
    archiveSession: sessionId => ctx.workspaces.archiveSession(sessionId as SessionId),
    deleteWorkspace: workspaceId => ctx.workspaces.delete(workspaceId as WorkspaceId),
  }

  /** Open a blank session in the main workspace of a repository. */
  const leaveWorktree: WorktreeOps['leaveWorktree'] = (repoRoot) => {
    const existing = workspaceAt(repoRoot, ctx.workspaces.list.getSnapshot().items)
    if (existing !== undefined) {
      ctx.uiWorkspace.startSession(existing.workspaceId)
      return
    }
    void ctx.workspaces.create({ path: repoRoot }).then(
      (workspace) => { ctx.uiWorkspace.startSession(workspace.workspaceId) },
      () => { /* the user stays where they are */ },
    )
  }

  const ops: WorktreeOps = {
    removalFacts,
    removeFully: target => removeWorktreeFully(removalDeps, target),
    cleanupAfterMerge: (target, inside) => cleanupAfterMerge(removalDeps, () => { if (inside) leaveWorktree(target.repoRoot) }, target),
    leaveWorktree,
    modelRoute: (sessionId) => {
      if (sessionId === undefined) return undefined
      const selection = ctx.sessions.list.getSnapshot().projectionsBySession[sessionId as SessionId]?.values.modelSelection
      const model = selection === undefined ? undefined : selection.next ?? selection.lastUsed ?? undefined
      if (model === undefined) return undefined
      return {
        provider: model.provider,
        model: model.model,
        ...(model.reasoningEffort === undefined ? {} : { effort: model.reasoningEffort }),
      }
    },
    settings: () => {
      const section = settingsForm.getSnapshot().value
      return { autoCleanup: section?.autoCleanup ?? true, deleteBranchOnCleanup: section?.deleteBranchOnCleanup ?? true }
    },
    renameWorkspace: async (path, title) => {
      const workspace = workspaceAt(path, ctx.workspaces.list.getSnapshot().items)
      if (workspace === undefined) return false
      await ctx.workspaces.rename(workspace.workspaceId, title)
      return true
    },
    workspaceTitle: path => workspaceAt(path, ctx.workspaces.list.getSnapshot().items)?.title,
    locale: () => (ctx.locale.getLocale().active.toLowerCase().startsWith('zh') ? 'zh' : 'en'),
  }

  const chipsInjected = (): ChipsInjected => ({
    ...ops,
    namingMode: (): NamingMode => (settingsForm.getSnapshot().value?.namingMode === 'auto' ? 'auto' : 'manual'),
    adoptWorktree: async ({ path, title, draft }) => {
      const workspace = await ctx.workspaces.create({ path })
      try {
        await ctx.workspaces.rename(workspace.workspaceId, title)
      } catch {
        // The default title (the directory name) is an acceptable fallback.
      }
      await ctx.uiWorkspace.openWorkspace(workspace.workspaceId, (sessionId) => {
        if (draft !== '') pendingDrafts.set(sessionId, draft)
      })
    },
    takePendingDraft: (sessionId) => {
      const draft = pendingDrafts.get(sessionId)
      pendingDrafts.delete(sessionId)
      return draft
    },
  })

  const headerInjected = (): HeaderInjected => ops

  // Hero chips: a dock entry, portaled into the hero's workspace row.
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'worktree-manager-chips',
    order: 5,
    locale: NS,
    inject: chipsInjected,
  }, WorktreeChips))

  // Merge / delete of a managed worktree session.
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'worktree-manager-header',
    order: 20,
    locale: NS,
    inject: headerInjected,
  }, HeaderActions))

  // Configuration card + manager list on the bundle's Plugins page.
  const managerFace = (): ManagerFace => ({
    ...ops,
    workspacePaths: () => ctx.workspaces.list.getSnapshot().items.map(item => item.path),
  })
  const form = new CardForm(settingsForm)
  const store = form.bind()
  const describeFace = ctx.configForms.describe()
  let configDisposer: (() => void) | undefined
  const syncCardSeat = (): void => {
    const snapshot = describeFace.getSnapshot()
    const served = snapshot.status === 'ready'
      && (snapshot.view?.namespaces.some(entry => entry.ns === PLUGIN_ENTRY_ID) ?? false)
    if (served && configDisposer === undefined) {
      configDisposer = ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PLUGIN_PACKAGE,
        locale: NS,
        inject: () => ({
          hooks: { worktreeManagerCard: store },
          ...form.actions(),
          manager: managerFace(),
        }),
      }, ConfigCard))
    } else if (!served && configDisposer !== undefined) {
      configDisposer()
      configDisposer = undefined
    }
  }
  const unsubscribeDescribe = describeFace.subscribe(syncCardSeat)
  void describeFace.ensure()
  syncCardSeat()
  ctx.effect(() => () => {
    unsubscribeDescribe()
    if (configDisposer !== undefined) configDisposer()
  }, 'worktree-manager: plugin config card lifecycle')

}
