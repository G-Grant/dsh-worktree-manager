/**
 * Worktree manager list (configuration page): every worktree the plugin
 * created, with its facts and the merge / delete / retitle verbs.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, IconRefreshOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorktreeEntry } from '../wire.ts'
import { requestList } from './api.ts'
import { DeleteDialog } from './DeleteDialog.tsx'
import { onChanged } from './events.ts'
import { describeError, unwrap } from './flows.ts'
import type { T } from './locales.ts'
import { MergeDialog } from './MergeDialog.tsx'
import type { WorktreeOps } from './slots.ts'
import css from './ManagerList.module.css'

/** The face the list needs beyond the shared operations. */
export interface ManagerFace extends WorktreeOps {
  /** Directories of every registered workspace (the scan seeds). */
  workspacePaths(): string[]
}

export interface ManagerListProps {
  face: ManagerFace
  t: T
}

type Dialog = { kind: 'merge' | 'delete'; entry: WorktreeEntry } | null

/** Render the manager list. */
export function ManagerList({ face, t }: ManagerListProps) {
  const [entries, setEntries] = useState<readonly WorktreeEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [renaming, setRenaming] = useState<{ path: string; text: string } | null>(null)
  const [toasts, setToasts] = useState<readonly { seq: number; text: string }[]>([])
  const notify = useCallback((text: string) => {
    setToasts(queue => [...queue, { seq: (queue[queue.length - 1]?.seq ?? 0) + 1, text }])
  }, [])

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = unwrap(await requestList({ paths: face.workspacePaths() }))
      setEntries(result.worktrees)
      setError(null)
    } catch (cause) {
      setError(describeError(t, cause))
    }
  }, [face, t])

  useEffect(() => {
    void load()
    return onChanged(() => { void load() })
  }, [load])

  const rename = async (): Promise<void> => {
    if (renaming === null) return
    const title = renaming.text.trim()
    if (title === '') {
      setRenaming(null)
      return
    }
    try {
      const done = await face.renameWorkspace(renaming.path, title)
      if (!done) notify(t('manager.renameNone'))
    } catch (cause) {
      notify(describeError(t, cause))
    }
    setRenaming(null)
    await load()
  }

  const target = dialog === null
    ? null
    : { path: dialog.entry.path, repoRoot: dialog.entry.repoRoot, branch: dialog.entry.branch, base: dialog.entry.base }

  return (
    <section className={css.section}>
      <header className={css.header}>
        <h3 className={css.title}>{t('manager.title')}</h3>
        <Button variant="ghost" size="sm" icon={<IconRefreshOutlineRegular size={14} />} onClick={() => { void load() }}>
          {t('manager.refresh')}
        </Button>
      </header>
      {error !== null && <p className={css.bad} role="alert">{t('manager.loadFailed', { message: error })}</p>}
      {entries === null && error === null && <p className={css.hint}>{t('common.loading')}</p>}
      {entries !== null && entries.length === 0 && <p className={css.hint}>{t('manager.empty')}</p>}
      <ul className={css.list}>
        {(entries ?? []).map((entry) => {
          const title = face.workspaceTitle(entry.path)
          const editing = renaming?.path === entry.path
          return (
            <li key={entry.path} className={css.row}>
              <div className={css.main}>
                {editing
                  ? (
                    <input
                      className={css.rename}
                      autoFocus
                      value={renaming.text}
                      placeholder={t('manager.renamePlaceholder')}
                      onChange={(event) => { setRenaming({ path: entry.path, text: event.target.value }) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) void rename()
                        if (event.key === 'Escape') setRenaming(null)
                      }}
                      onBlur={() => { void rename() }}
                    />
                  )
                  : <span className={css.name}>{title ?? entry.branch}</span>}
                <span className={css.path} title={entry.path}>{entry.path}</span>
                <span className={css.badges}>
                  <span className={css.badge}>{t('manager.base', { base: entry.base })}</span>
                  {entry.ahead > 0 && <span className={css.badge}>{t('manager.ahead', { n: entry.ahead })}</span>}
                  {entry.dirty > 0 && <span className={css.badgeWarn}>{t('manager.dirty', { n: entry.dirty })}</span>}
                  {entry.merged && entry.ahead === 0 && <span className={css.badge}>{t('manager.merged')}</span>}
                  {entry.missing && <span className={css.badgeBad}>{t('manager.missing')}</span>}
                </span>
              </div>
              <div className={css.actions}>
                {!entry.missing && <Button variant="ghost" size="sm" onClick={() => { setDialog({ kind: 'merge', entry }) }}>{t('manager.merge')}</Button>}
                <Button variant="ghost" size="sm" onClick={() => { setRenaming({ path: entry.path, text: title ?? '' }) }}>{t('manager.rename')}</Button>
                <Button variant="ghost" size="sm" onClick={() => { setDialog({ kind: 'delete', entry }) }}>{t('manager.delete')}</Button>
              </div>
            </li>
          )
        })}
      </ul>
      {target !== null && dialog !== null && (
        <>
          <MergeDialog
            open={dialog.kind === 'merge'}
            onClose={() => { setDialog(null) }}
            target={target}
            inside={false}
            ops={face}
            notify={notify}
            t={t}
          />
          <DeleteDialog
            open={dialog.kind === 'delete'}
            onClose={() => { setDialog(null) }}
            target={target}
            inside={false}
            ops={face}
            notify={notify}
            t={t}
          />
        </>
      )}
      {toasts[0] !== undefined && <Toast key={toasts[0].seq} text={toasts[0].text} onDone={() => { setToasts(queue => queue.slice(1)) }} />}
    </section>
  )
}
