/**
 * Pure name / path normalization shared by the host (git command assembly,
 * config validation) and the client (forms). Nothing here touches the disk.
 */

/** Longest accepted worktree (= branch) name. */
export const NAME_LIMIT = 80

/** Why a user-typed worktree name is not acceptable (null = fine). */
export type NameIssue = 'empty' | 'tooLong' | 'illegal'

/**
 * Characters a worktree name may use after the first: letters (Chinese
 * included), digits, and the punctuation git and the directory segment can
 * both keep. The first character stays a letter or digit so the name cannot
 * be read as a git option.
 */
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u

/**
 * Pre-flight check of a user-typed worktree name. The name is also the new
 * branch name, so it must satisfy git's ref-name rules. Chinese is accepted
 * on purpose: the same text is the branch, the directory segment, and the
 * workspace title, and a Chinese name is easier to tell apart.
 * `git worktree add -b` stays the authority; this only feeds form feedback.
 * @param name - raw draft text (NOT trimmed: a space is a real issue).
 * @returns the issue kind, or null when acceptable.
 */
export function nameIssue(name: string): NameIssue | null {
  if (name.trim() === '') return 'empty'
  if (name.length > NAME_LIMIT) return 'tooLong'
  if (!NAME_PATTERN.test(name)) return 'illegal'
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return 'illegal'
  if (name.endsWith('/') || name.endsWith('.')) return 'illegal'
  if (/(^|\/)\./.test(name)) return 'illegal'
  if (/(^|\/)[^/]+\.lock($|\/)/.test(name)) return 'illegal'
  return null
}

/**
 * Turn a branch name into one safe directory segment: `feat/login` →
 * `feat-login`. Every separator and Windows-forbidden character becomes `-`,
 * runs of `-`/`.` collapse, trailing dots are stripped, and the result is
 * never empty.
 * @param name - branch name.
 * @returns a single path segment.
 */
export function sanitizeDirName(name: string): string {
  const replaced = name.replace(/[<>:"/\\|?*\u0000-\u001f\s]/g, '-')
  const merged = replaced.replace(/[-.]{2,}/g, '-')
  const trimmed = merged.replace(/[.\s-]+$/, '').slice(0, 64).replace(/[.\s-]+$/, '')
  return trimmed === '' || trimmed.replaceAll('-', '') === '' ? 'worktree' : trimmed
}

/** Alphabet of the auto-generated short code (lowercase, no lookalikes). */
const SHORT_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/**
 * Build an auto worktree name `wt-xxxxxx` from random bytes.
 * @param bytes - at least six random bytes (injected for determinism).
 * @returns the generated name.
 */
export function shortCodeName(bytes: ArrayLike<number>): string {
  let code = ''
  for (let index = 0; index < 6; index++) {
    code += SHORT_ALPHABET[(bytes[index] ?? 0) % SHORT_ALPHABET.length]
  }
  return `wt-${code}`
}

/**
 * Local branch name of a display name: strips a leading `<remote>/` when the
 * name is a remote ref (`origin/main` → `main`). Callers that must be certain
 * compare against the authoritative branch list.
 * @param branch - branch display name.
 */
export function localBranchName(branch: string): string {
  const at = branch.indexOf('/')
  return at <= 0 ? branch : branch.slice(at + 1)
}

/**
 * Whether a configured path is absolute on any platform (POSIX `/…`,
 * Windows drive `C:\…`, UNC `\\…`).
 * @param value - raw settings string.
 */
export function isAbsoluteConfigPath(value: string): boolean {
  if (value === '') return false
  if (value.startsWith('/') || value.startsWith('\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

/**
 * Whether a copy-list entry is a safe repository-relative path: non-empty,
 * not absolute, no `..` segment, no NUL, and not inside `.git`.
 * @param entry - one line of `.worktreeinclude` or the configured list.
 */
export function isSafeRelativePath(entry: string): boolean {
  const value = entry.trim().replaceAll('\\', '/')
  if (value === '' || value.includes('\u0000')) return false
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0) return false
  if (segments.includes('..')) return false
  if (segments[0] === '.git') return false
  return true
}

/**
 * Parse `.worktreeinclude` text: one entry per line, `#` comments and blank
 * lines ignored, surrounding whitespace trimmed.
 * @param text - file content.
 */
export function parseIncludeFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
}

/**
 * Compile a single-level glob (`*` and `?` inside one path segment) to a
 * regular expression anchored on the whole segment.
 * @param pattern - one path segment, possibly with wildcards.
 */
export function segmentGlob(pattern: string): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${source}$`)
}
