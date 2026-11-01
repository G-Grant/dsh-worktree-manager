/**
 * Delete dialog: remove one managed worktree through the shared removal flow
 * (git first, then archive its sessions and unregister its workspace).
 *
 * Consequences are spelled out up front: uncommitted entries need an explicit
 * confirmation, and deleting a branch that git does not see merged needs a
 * second one (the host refuses without it). A directory holding a running
 * session withholds the verb.
 */

import { useEffect, useState } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { requestInspect } from './api.ts'
import { emitChanged } from './events.ts'
import { describeError, unwrap } from './flows.ts'
import type { T } from './locales.ts'
import type { WorktreeOps } from './slots.ts'
import css from './ui.module.css'

/** The worktree being deleted. */
export interface DeleteTarget {
  path: string
  repoRoot: string
  branch: string
  base: string
}

export interface DeleteDialogProps {
  open: boolean
  onClose: () => void
  target: DeleteTarget
  /** The current view sits inside this worktree. */
  inside: boolean
  ops: WorktreeOps
  notify: (text: string) => void
  t: T
}

interface Facts {
  dirty: number
  ahead: number
  merged: boolean
  missing: boolean
}

/** Render the delete dialog. */
export function DeleteDialog({ open, onClose, target, inside, ops, notify, t }: DeleteDialogProps) {
  const [facts, setFacts] = useState<Facts | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [confirmDirty, setConfirmDirty] = useState(false)
  const [confirmUnmerged, setConfirmUnmerged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setFacts(null)
    setLoadError(null)
    setError(null)
    setConfirmDirty(false)
    setConfirmUnmerged(false)
    setDeleteBranch(ops.settings().deleteBranchOnCleanup)
    void requestInspect({ path: target.path, repoRoot: target.repoRoot }).then((result) => {
      if (!live) return
      try {
        const { entry } = unwrap(result)
        setFacts({ dirty: entry.dirty, ahead: entry.ahead, merged: entry.merged, missing: entry.missing })
      } catch (cause) {
        setLoadError(describeError(t, cause))
      }
    })
    return () => { live = false }
  }, [open, target.path, target.repoRoot, ops, t])

  const removal = ops.removalFacts(target.path)
  const unmerged = facts !== null && !facts.merged
  const needsDirtyConfirm = facts !== null && facts.dirty > 0
  const needsUnmergedConfirm = deleteBranch && unmerged
  const ready = facts !== null
    && !removal.running
    && (!needsDirtyConfirm || confirmDirty)
    && (!needsUnmergedConfirm || confirmUnmerged)
  const canDelete = ready && !busy

  const submit = async (): Promise<void> => {
    if (!canDelete || facts === null) return
    setBusy(true)
    setError(null)
    try {
      if (inside) ops.leaveWorktree(target.repoRoot)
      const outcome = await ops.removeFully({
        path: target.path,
        repoRoot: target.repoRoot,
        force: needsDirtyConfirm,
        deleteBranch,
        forceBranch: needsUnmergedConfirm,
        facts: removal,
      })
      emitChanged()
      notify(outcome.leftovers.length > 0
        ? t('delete.doneLeft', { branch: target.branch, n: outcome.leftovers.length })
        : t('delete.done', { branch: target.branch }))
      onClose()
    } catch (cause) {
      setError(describeError(t, cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t('delete.title', { branch: target.branch })}
      closeLabel={t('common.close')}
      footer={(
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={!canDelete} onClick={() => { void submit() }}>
            {busy ? t('delete.busy') : t('delete.submit')}
          </Button>
        </>
      )}
    >
      <div className={css.body}>
        {loadError !== null && <p className={css.hintBad} role="alert">{loadError}</p>}
        {facts === null && loadError === null && <p className={css.hint}>{t('common.loading')}</p>}
        <p className={css.hint}>{t('delete.body', { path: target.path })}</p>
        {removal.archiveSessionIds.length > 0 && <p className={css.hint}>{t('delete.sessions', { count: removal.archiveSessionIds.length })}</p>}
        {removal.running && <p className={css.hintBad} role="alert">{t('delete.running')}</p>}
        {facts !== null && (
          <>
            <Checkbox
              checked={deleteBranch}
              disabled={busy}
              onChange={setDeleteBranch}
              label={t('delete.deleteBranch', { branch: target.branch })}
            />
            {needsDirtyConfirm && (
              <div className={css.notice}>
                <p className={css.hintWarn}>{t('delete.dirtyWarn', { count: facts.dirty })}</p>
                <Checkbox checked={confirmDirty} disabled={busy} onChange={setConfirmDirty} label={t('delete.dirtyConfirm')} />
              </div>
            )}
            {needsUnmergedConfirm && (
              <div className={css.notice}>
                <p className={css.hintWarn}>{t('delete.unmergedWarn', { ahead: facts.ahead })}</p>
                <Checkbox checked={confirmUnmerged} disabled={busy} onChange={setConfirmUnmerged} label={t('delete.unmergedConfirm')} />
              </div>
            )}
          </>
        )}
        {error !== null && <p className={css.hintBad} role="alert">{error}</p>}
      </div>
    </Modal>
  )
}
