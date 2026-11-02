/**
 * Form over the `dsh-worktree-manager` Host entry.
 *
 * The copy list is STAGED: a settings write is a durable, revision-fenced
 * document mutation, so that control keeps a draft and commits it on save.
 * The naming mode and the cleanup switches are WRITE-THROUGH: they flip
 * immediately, and a refused write is recorded so the card can say which
 * switch did not take.
 *
 * Self-contained on purpose: the client bundle-purity rule forbids value
 * imports across plugins, so this package stages and fences its own form.
 */

import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { isSafeRelativePath } from '../normalize.ts'
import type { NamingMode } from './slots.ts'

export const NAMING_FIELD = 'namingMode'
export const CLEANUP_FIELD = 'autoCleanup'
export const DELETE_BRANCH_FIELD = 'deleteBranchOnCleanup'
export const FETCH_BASE_FIELD = 'fetchBaseBeforeCreate'
export const COPY_FIELD = 'copyFiles'

/** The resolved user-facing section the card edits. */
export interface SectionValue {
  namingMode?: NamingMode
  autoCleanup?: boolean
  deleteBranchOnCleanup?: boolean
  fetchBaseBeforeCreate?: boolean
  copyFiles?: string[]
}

/** Which write-through switch failed to persist. */
export type SwitchField =
  typeof NAMING_FIELD | typeof CLEANUP_FIELD | typeof DELETE_BRANCH_FIELD | typeof FETCH_BASE_FIELD

/** What the configuration card renders. */
export interface CardState {
  /** False while the namespace is not served to this client. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  namingMode: NamingMode
  autoCleanup: boolean
  deleteBranchOnCleanup: boolean
  fetchBaseBeforeCreate: boolean
  /** Copy list as multi-line text: the live draft, else the stored list. */
  copyFilesText: string
  /** True when every copy line is a safe relative path. */
  copyFilesValid: boolean
  /** Whether a save would write something. */
  dirty: boolean
  saving: boolean
  /** The last save did not land as staged. */
  failed: boolean
  switchFailed: SwitchField | null
}

/** Minimal observable snapshot source (stable reference until the fact moves). */
export interface CardStore {
  getSnapshot(): CardState
  subscribe(listener: () => void): () => void
  set(next: CardState): void
}

/** The form actions the card's slot entry injects. */
export interface CardActions {
  save: () => Promise<void>
  discard: () => void
  editCopyFiles: (text: string) => void
  setNamingMode: (value: NamingMode) => void
  setAutoCleanup: (value: boolean) => void
  setDeleteBranchOnCleanup: (value: boolean) => void
  setFetchBaseBeforeCreate: (value: boolean) => void
}

/**
 * Parse multi-line text into clean entries (blank lines dropped).
 * @param text - raw textarea value.
 */
export function parseLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
}

function sameState(a: CardState, b: CardState): boolean {
  return (Object.keys(a) as (keyof CardState)[]).every(key => a[key] === b[key])
}

/** Stages settings edits over the Host entry. */
export class CardForm {
  private snapshotValue: CardState
  private readonly listeners = new Set<() => void>()
  private copyDraft: string | undefined
  private saving = false
  private failed = false
  private switchFailed: SwitchField | null = null

  /** @param scope - the bound configuration form of the Host entry. */
  constructor(private readonly scope: ConfigForm<SectionValue>) {
    this.snapshotValue = this.project()
    scope.subscribe(() => { this.publish() })
  }

  /** The store the card reads through its bound selector hook. */
  bind(): CardStore {
    return {
      getSnapshot: () => this.snapshotValue,
      subscribe: (listener) => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
      set: (next) => { this.store(next) },
    }
  }

  /** The actions bound to this form. */
  actions(): CardActions {
    return {
      save: () => this.save(),
      discard: () => {
        if (this.copyDraft === undefined && !this.failed) return
        this.copyDraft = undefined
        this.failed = false
        this.publish()
      },
      editCopyFiles: (text) => {
        this.copyDraft = text
        this.failed = false
        this.publish()
      },
      setNamingMode: value => this.flip(NAMING_FIELD, value),
      setAutoCleanup: value => this.flip(CLEANUP_FIELD, value),
      setDeleteBranchOnCleanup: value => this.flip(DELETE_BRANCH_FIELD, value),
      setFetchBaseBeforeCreate: value => this.flip(FETCH_BASE_FIELD, value),
    }
  }

  /** Flip a write-through setting; a refused or failed write is recorded, never thrown. */
  private async flip(field: SwitchField, value: string | boolean): Promise<void> {
    const current = this.scope.getSnapshot().value?.[field]
    if (value === current) return
    try {
      const landed = await this.scope.set(field, value)
      this.switchFailed = landed ? (this.switchFailed === field ? null : this.switchFailed) : field
    } catch {
      this.switchFailed = field
    }
    this.publish()
  }

  private storedCopyText(): string {
    const list = this.scope.getSnapshot().value?.[COPY_FIELD]
    return Array.isArray(list) ? list.join('\n') : ''
  }

  private async save(): Promise<void> {
    if (this.copyDraft === undefined || this.saving) return
    const copyLines = parseLines(this.copyDraft)
    if (!copyLines.every(isSafeRelativePath)) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      landed = await this.scope.set(COPY_FIELD, copyLines)
    } catch {
      landed = false
    }
    if (landed) this.copyDraft = undefined
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private project(): CardState {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    const copyText = this.copyDraft ?? this.storedCopyText()
    const copyValid = parseLines(copyText).every(isSafeRelativePath)
    const copyDirty = this.copyDraft !== undefined && parseLines(this.copyDraft).join('\n') !== this.storedCopyText()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      namingMode: value?.namingMode === 'auto' ? 'auto' : 'manual',
      autoCleanup: value?.autoCleanup ?? true,
      deleteBranchOnCleanup: value?.deleteBranchOnCleanup ?? true,
      fetchBaseBeforeCreate: value?.fetchBaseBeforeCreate ?? true,
      copyFilesText: copyText,
      copyFilesValid: copyValid,
      dirty: copyDirty,
      saving: this.saving,
      failed: this.failed,
      switchFailed: this.switchFailed,
    }
  }

  private store(next: CardState): void {
    if (sameState(next, this.snapshotValue)) return
    this.snapshotValue = next
    for (const listener of this.listeners) listener()
  }

  private publish(): void {
    this.store(this.project())
  }
}
