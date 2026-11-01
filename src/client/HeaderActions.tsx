/**
 * Session header actions: shown only while the session's directory is a
 * managed linked worktree. Reads `feat-x → main` plus the 「合并」 and 「删除」
 * verbs that open the merge / delete dialogs.
 */

import { useCallback, useState } from 'react'
import { Button, IconBranchOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the session standard kit (`sessionId`, `useSessions`, ...).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: merges `useInput` / `inputActions` into the session kit.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { DeleteDialog } from './DeleteDialog.tsx'
import { MergeDialog } from './MergeDialog.tsx'
import type { HeaderInjected } from './slots.ts'
import { useRepoStatus } from './useRepoStatus.ts'
import css from './ui.module.css'

export type HeaderActionsProps =
  PropsRuntime<'conversation.session.header.actions'>
  & HeaderInjected
  & PropsLocale<'worktree-manager'>

type Dialog = 'merge' | 'delete' | null

/** The header entry. */
export function HeaderActions(props: HeaderActionsProps) {
  const { sessionId, useSessions, inputActions, t } = props
  const ops: HeaderInjected = props
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const [facts] = useRepoStatus(cwd)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [toasts, setToasts] = useState<readonly { seq: number; text: string }[]>([])
  const notify = useCallback((text: string) => {
    setToasts(queue => [...queue, { seq: (queue[queue.length - 1]?.seq ?? 0) + 1, text }])
  }, [])

  const managed = facts?.managed
  if (facts === null || managed === undefined) {
    // Keep the toast host alive while a just-cleaned worktree session unmounts.
    return toasts[0] === undefined ? null : <Toast key={toasts[0].seq} text={toasts[0].text} onDone={() => { setToasts(queue => queue.slice(1)) }} />
  }
  const target = { path: facts.toplevel, repoRoot: facts.repoRoot, branch: managed.branch, base: managed.base }
  const close = (): void => { setDialog(null) }

  return (
    <>
      <span className={css.headerGroup}>
        <span className={css.headerBranch} title={t('header.title', { branch: managed.branch, base: managed.base })}>
          <IconBranchOutlineRegular size={14} />
          <span className={css.chipLabel}>{t('header.label', { branch: managed.branch, base: managed.base })}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={() => { setDialog('merge') }}>{t('header.merge')}</Button>
        <Button variant="ghost" size="sm" onClick={() => { setDialog('delete') }}>{t('header.delete')}</Button>
      </span>
      <MergeDialog
        open={dialog === 'merge'}
        onClose={close}
        target={target}
        sessionId={sessionId}
        inside
        ops={ops}
        onHandoff={(prompt) => {
          inputActions.setDraft(prompt)
          window.setTimeout(() => { inputActions.submit() }, 50)
        }}
        notify={notify}
        t={t}
      />
      <DeleteDialog open={dialog === 'delete'} onClose={close} target={target} inside ops={ops} notify={notify} t={t} />
      {toasts[0] !== undefined && <Toast key={toasts[0].seq} text={toasts[0].text} onDone={() => { setToasts(queue => queue.slice(1)) }} />}
    </>
  )
}
