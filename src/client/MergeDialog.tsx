/**
 * Merge dialog: merge one managed worktree into its target branch.
 *
 * The dialog reads the facts up front (commits ahead, uncommitted entries,
 * the main checkout's branch and cleanliness) and refuses before git is asked
 * when a pre-check would fail. Strategy is the user's choice — a merge commit
 * or a single squashed commit — and is remembered. A conflict is rolled back
 * by the host; the dialog lists the files and can hand them to the agent.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Modal, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MergeStrategy } from '../wire.ts'
import { fetchStatus, requestInspect, requestMerge, requestSquashMessage } from './api.ts'
import { emitChanged } from './events.ts'
import { pathKey } from './facts.ts'
import { CallError, conflictPrompt, describeError, unwrap } from './flows.ts'
import type { T } from './locales.ts'
import type { WorktreeOps } from './slots.ts'
import type { RepoFacts } from './useRepoStatus.ts'
import css from './ui.module.css'

/** The worktree being merged. */
export interface MergeTarget {
  path: string
  repoRoot: string
  branch: string
  base: string
}

export interface MergeDialogProps {
  open: boolean
  onClose: () => void
  target: MergeTarget
  /** Session whose model drafts the squash message (absent = no AI). */
  sessionId?: string | undefined
  /** The current view sits inside this worktree. */
  inside: boolean
  ops: WorktreeOps
  /** Send a prompt to the current session (absent hides the handoff button). */
  onHandoff?: ((prompt: string) => void) | undefined
  /** Report a result line to the host's toast. */
  notify: (text: string) => void
  t: T
}

const STRATEGY_KEY = 'dsh-worktree-manager:strategy'

function readStrategy(): MergeStrategy {
  try {
    return window.localStorage.getItem(STRATEGY_KEY) === 'squash' ? 'squash' : 'merge'
  } catch {
    return 'merge'
  }
}

function storeStrategy(value: MergeStrategy): void {
  try {
    window.localStorage.setItem(STRATEGY_KEY, value)
  } catch {
    // Storage may be unavailable; the choice just is not remembered.
  }
}

interface Loaded {
  facts: RepoFacts
  ahead: number
  dirty: number
}

/** Render the merge dialog. */
export function MergeDialog(props: MergeDialogProps) {
  const { open, onClose, target, sessionId, inside, ops, onHandoff, notify } = props
  const { t } = props
  const settings = ops.settings()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [targetBranch, setTargetBranch] = useState(target.base)
  const [strategy, setStrategy] = useState<MergeStrategy>(readStrategy)
  const [message, setMessage] = useState('')
  const [messageNote, setMessageNote] = useState<'loading' | 'ai' | 'list' | null>(null)
  const [cleanup, setCleanup] = useState(settings.autoCleanup)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<CallError | Error | null>(null)
  /** Bumped on every open: results of an earlier open never land in this one. */
  const openToken = useRef(0)
  /** The squash draft is requested once per open. */
  const draftRequested = useRef(false)
  const messageTouchedRef = useRef(false)

  // Fresh facts every time the dialog opens.
  useEffect(() => {
    if (!open) return
    let live = true
    openToken.current += 1
    draftRequested.current = false
    messageTouchedRef.current = false
    setLoaded(null)
    setLoadError(null)
    setFailure(null)
    setTargetBranch(target.base)
    setMessage('')
    setMessageNote(null)
    setCleanup(ops.settings().autoCleanup)
    void (async () => {
      try {
        const [status, inspected] = await Promise.all([
          fetchStatus(target.path),
          requestInspect({ path: target.path, repoRoot: target.repoRoot }),
        ])
        if (!live) return
        if (!status.ok || !status.repo) throw new Error(status.ok ? 'not a git repository' : status.error)
        const entry = unwrap(inspected).entry
        setLoaded({ facts: status, ahead: entry.ahead, dirty: entry.dirty })
      } catch (error) {
        if (live) setLoadError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => { live = false }
  }, [open, target.path, target.repoRoot, target.base, ops])

  // Draft the squash message once per open, the first time squash is chosen.
  useEffect(() => {
    if (!open || strategy !== 'squash' || draftRequested.current) return
    draftRequested.current = true
    const token = openToken.current
    setMessageNote('loading')
    const route = ops.modelRoute(sessionId)
    void requestSquashMessage({
      path: target.path,
      ...(route === undefined ? {} : { provider: route.provider, model: route.model, ...(route.effort === undefined ? {} : { effort: route.effort }) }),
    }).then((result) => {
      if (token !== openToken.current) return
      if (result.ok) {
        if (!messageTouchedRef.current) setMessage(result.message)
        setMessageNote(result.ai ? 'ai' : 'list')
      } else {
        setMessageNote('list')
      }
    })
  }, [open, strategy, ops, sessionId, target.path])

  // Targets are local branches the main checkout can be on: not the worktree's
  // own branch and not a branch another linked worktree holds.
  const targets = useMemo(
    () => (loaded?.facts.branches ?? [])
      .filter(branch => !branch.remote && branch.name !== target.branch
        && (branch.occupiedBy === undefined || pathKey(branch.occupiedBy) === pathKey(target.repoRoot)))
      .map(branch => branch.name),
    [loaded, target.branch, target.repoRoot],
  )
  const options = targets.includes(targetBranch) ? targets : [targetBranch, ...targets]

  const main = loaded?.facts.mainCheckout
  const blockers: string[] = []
  if (loaded !== null) {
    if (loaded.dirty > 0) blockers.push(t('merge.worktreeDirty', { count: loaded.dirty }))
    if (main === undefined || main.branch !== targetBranch) {
      blockers.push(t('merge.mainNotOnTarget', { current: main?.branch ?? 'HEAD', target: targetBranch }))
    } else if (main.dirty > 0) {
      blockers.push(t('merge.mainDirty', { count: main.dirty }))
    }
    if (loaded.ahead === 0) blockers.push(t('merge.nothing'))
  }
  const squashNeedsMessage = strategy === 'squash' && (messageNote === 'loading' || message.trim() === '')
  const canMerge = !busy && loaded !== null && blockers.length === 0 && !squashNeedsMessage

  const submit = async (): Promise<void> => {
    if (!canMerge) return
    setBusy(true)
    setFailure(null)
    try {
      const result = unwrap(await requestMerge({
        path: target.path,
        target: targetBranch,
        strategy,
        ...(strategy === 'squash' ? { message } : {}),
      }))
      emitChanged()
      let line = t('merge.done', { target: result.target })
      if (cleanup) {
        const outcome = await ops.cleanupAfterMerge({
          path: target.path,
          repoRoot: target.repoRoot,
          force: false,
          deleteBranch: ops.settings().deleteBranchOnCleanup,
          forceBranch: true,
          facts: ops.removalFacts(target.path),
        }, inside)
        emitChanged()
        if (outcome.done) {
          line = outcome.outcome.leftovers.length > 0
            ? t('delete.doneLeft', { branch: target.branch, n: outcome.outcome.leftovers.length })
            : t('merge.doneCleaned', { target: result.target })
        } else if (outcome.reason === 'running') {
          line = t('merge.doneRunning', { target: result.target })
        } else {
          line = t('merge.doneCleanupFailed', { target: result.target, message: describeError(t, outcome.error) })
        }
      }
      notify(line)
      onClose()
    } catch (error) {
      setFailure(error instanceof Error ? error : new Error(String(error)))
    } finally {
      setBusy(false)
    }
  }

  const conflict = failure instanceof CallError && failure.code === 'conflict' ? failure : null

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t('merge.title', { branch: target.branch })}
      closeLabel={t('common.close')}
      footer={(
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={!canMerge} onClick={() => { void submit() }}>
            {busy ? t('merge.busy') : t('merge.submit')}
          </Button>
        </>
      )}
    >
      <div className={css.body}>
        {loadError !== null && <p className={css.hintBad} role="alert">{loadError}</p>}
        {loaded === null && loadError === null && <p className={css.hint}>{t('common.loading')}</p>}
        {loaded !== null && (
          <>
            <p className={css.facts}>
              <span>{t('merge.facts', { ahead: loaded.ahead, dirty: loaded.dirty })}</span>
              <span>{t('merge.mainFacts', { branch: main?.branch ?? 'HEAD', dirty: main?.dirty ?? 0 })}</span>
            </p>
            <label className={css.field}>
              <span className={css.label}>{t('merge.target')}</span>
              <select className={css.select} value={targetBranch} disabled={busy} onChange={(event) => { setTargetBranch(event.target.value) }}>
                {options.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <div className={css.field}>
              <span className={css.label}>{t('merge.strategy')}</span>
              <SegmentedControl
                id="wtm-merge-strategy"
                label={t('merge.strategy')}
                value={strategy}
                disabled={busy}
                options={[
                  { value: 'merge', label: t('merge.strategyMerge') },
                  { value: 'squash', label: t('merge.strategySquash') },
                ]}
                onChange={(next) => { setStrategy(next); storeStrategy(next) }}
              />
              <p className={css.hint}>{strategy === 'merge' ? t('merge.strategyMergeHint') : t('merge.strategySquashHint')}</p>
            </div>
            {strategy === 'squash' && (
              <label className={css.field}>
                <span className={css.label}>{t('merge.message')}</span>
                <textarea
                  className={css.textarea}
                  value={message}
                  disabled={busy || messageNote === 'loading'}
                  placeholder={messageNote === 'loading' ? t('merge.messageLoading') : ''}
                  onChange={(event) => { setMessage(event.target.value); messageTouchedRef.current = true }}
                />
                {messageNote === 'ai' && <p className={css.hint}>{t('merge.messageAi')}</p>}
                {messageNote === 'list' && <p className={css.hint}>{t('merge.messageList')}</p>}
              </label>
            )}
            <Checkbox checked={cleanup} disabled={busy} onChange={setCleanup} label={t('merge.cleanup')} />
            {blockers.length > 0 && (
              <div className={css.notice} role="status">
                {blockers.map(text => <p key={text} className={css.hintWarn}>{text}</p>)}
              </div>
            )}
          </>
        )}
        {conflict !== null && (
          <div className={css.notice} role="alert">
            <p className={css.hintBad}>{t('merge.conflictTitle', { files: conflict.files?.length ?? 0 })}</p>
            <ul className={css.files}>
              {(conflict.files ?? []).map(file => <li key={file}>{file}</li>)}
            </ul>
            {onHandoff !== undefined && (
              <div className={css.actions}>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onHandoff(conflictPrompt({ branch: target.branch, target: targetBranch, files: conflict.files ?? [] }, ops.locale()))
                    notify(t('merge.handoffSent'))
                    onClose()
                  }}
                >
                  {t('merge.handoff')}
                </Button>
              </div>
            )}
          </div>
        )}
        {failure !== null && conflict === null && <p className={css.hintBad} role="alert">{describeError(t, failure)}</p>}
      </div>
    </Modal>
  )
}
