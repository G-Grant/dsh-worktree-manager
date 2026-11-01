/**
 * Form over the `dsh-worktree-manager` Host entry.
 *
 * The worktree root and the copy list are STAGED: a settings write is a
 * durable, revision-fenced document mutation, so those controls keep a draft
 * and commit it on save. The naming mode and the cleanup switches are
 * WRITE-THROUGH: they flip immediately, and a refused write is recorded so
 * the card can say which switch did not take.
 *
 * Self-contained on purpose: the client bundle-purity rule forbids value
 * imports across plugins, so this package stages and fences its own form.
 */

import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { isAbsoluteConfigPath, isSafeRelativePath } from '../normalize.ts'
import type { NamingMode } from './slots.ts'

export const ROOT_FIELD = 'rootDir'
export const NAMING_FIELD = 'namingMode'
export const CLEANUP_FIELD = 'autoCleanup'
export const DELETE_BRANCH_FIELD = 'deleteBranchOnCleanup'
export const COPY_FIELD = 'copyFiles'

/** The resolved user-facing section the card edits. */
export interface SectionValue {
  rootDir?: string
  namingMode?: NamingMode
  autoCleanup?: boolean
  deleteBranchOnCleanup?: boolean
  copyFiles?: string[]
}

/** Which write-through switch failed to persist. */
export type SwitchField = typeof NAMING_FIELD | typeof CLEANUP_FIELD | typeof DELETE_BRANCH_FIELD

/** What the configuration card renders. */
export interface CardState {
  /** False while the namespace is not served to this client. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Root field text: the live draft, else the stored value ('' = default). */
  rootDirText: string
  /** True when the root draft is blank or an absolute path. */
  rootDirValid: boolean
  /** Whether the user layer carries a custom root. */
  overridden: boolean
  namingMode: NamingMode
  autoCleanup: boolean
  deleteBranchOnCleanup: boolean
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
  editRootDir: (text: string) => void
  editCopyFiles: (text: string) => void
  setNamingMode: (value: NamingMode) => void
  setAutoCleanup: (value: boolean) => void
  setDeleteBranchOnCleanup: (value: boolean) => void
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
  private rootDraft: string | undefined
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
        if (this.rootDraft === undefined && this.copyDraft === undefined && !this.failed) return
        this.rootDraft = undefined
        this.copyDraft = undefined
        this.failed = false
        this.publish()
      },
      editRootDir: (text) => {
        this.rootDraft = text
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

  private storedRoot(): string {
    const value = this.scope.getSnapshot().value?.[ROOT_FIELD]
    return typeof value === 'string' ? value : ''
  }

  private storedCopyText(): string {
    const list = this.scope.getSnapshot().value?.[COPY_FIELD]
    return Array.isArray(list) ? list.join('\n') : ''
  }

  private async save(): Promise<void> {
    if ((this.rootDraft === undefined && this.copyDraft === undefined) || this.saving) return
    const rootText = (this.rootDraft ?? this.storedRoot()).trim()
    const copyLines = parseLines(this.copyDraft ?? this.storedCopyText())
    if (rootText !== '' && !isAbsoluteConfigPath(rootText)) return
    if (!copyLines.every(isSafeRelativePath)) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    try {
      if (this.rootDraft !== undefined) {
        landed = (rootText === '' ? await this.scope.unset(ROOT_FIELD) : await this.scope.set(ROOT_FIELD, rootText)) && landed
      }
      if (landed && this.copyDraft !== undefined) {
        landed = await this.scope.set(COPY_FIELD, copyLines) && landed
      }
    } catch {
      landed = false
    }
    if (landed) {
      this.rootDraft = undefined
      this.copyDraft = undefined
    }
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private project(): CardState {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    const user = typeof snapshot.user === 'object' && snapshot.user !== null ? snapshot.user as Record<string, unknown> : undefined
    const rootText = this.rootDraft ?? this.storedRoot()
    const copyText = this.copyDraft ?? this.storedCopyText()
    const rootValid = rootText.trim() === '' || isAbsoluteConfigPath(rootText.trim())
    const copyValid = parseLines(copyText).every(isSafeRelativePath)
    const rootDirty = this.rootDraft !== undefined && this.rootDraft.trim() !== this.storedRoot()
    const copyDirty = this.copyDraft !== undefined && parseLines(this.copyDraft).join('\n') !== this.storedCopyText()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      rootDirText: rootText,
      rootDirValid: rootValid,
      overridden: user !== undefined && Object.hasOwn(user, ROOT_FIELD),
      namingMode: value?.namingMode === 'auto' ? 'auto' : 'manual',
      autoCleanup: value?.autoCleanup ?? true,
      deleteBranchOnCleanup: value?.deleteBranchOnCleanup ?? true,
      copyFilesText: copyText,
      copyFilesValid: copyValid,
      dirty: rootDirty || copyDirty,
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
