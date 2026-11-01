/**
 * Post-create file copy: carries untracked / ignored files (`.env`, local
 * config) from the main checkout into a fresh worktree. The entry list is the
 * repository's `.worktreeinclude` plus the configured list. Entries are
 * repository-relative paths of files or directories; the last segment may use
 * `*` / `?`. Everything is confined to the repository, existing targets are
 * never overwritten and symbolic links are never followed.
 */

import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { isSafeRelativePath, parseIncludeFile, segmentGlob } from './normalize.js'

/** Outcome of one copy run. */
export interface CopyOutcome {
  /** Repository-relative paths that were copied. */
  copied: string[]
  /** Human-readable reasons of entries that were skipped. */
  warnings: string[]
}

/** Name of the repository-level include file. */
export const INCLUDE_FILE = '.worktreeinclude'

/** Whether `child` is `root` itself or lies below it. */
function inside(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep)
}

/** Read the include file; a missing file is an empty list. */
async function readIncludeFile(repoRoot: string): Promise<string[]> {
  try {
    return parseIncludeFile(await readFile(join(repoRoot, INCLUDE_FILE), 'utf8'))
  } catch {
    return []
  }
}

/** Expand one normalized entry into concrete repository-relative paths. */
async function expand(repoRoot: string, segments: string[], warnings: string[], entry: string): Promise<string[]> {
  const last = segments[segments.length - 1] as string
  const parents = segments.slice(0, -1)
  if (parents.some(segment => /[*?]/.test(segment))) {
    warnings.push(`${entry}: wildcards are only supported in the last path segment`)
    return []
  }
  if (!/[*?]/.test(last)) return [segments.join('/')]
  const matcher = segmentGlob(last)
  try {
    const names = await readdir(join(repoRoot, ...parents))
    return names.filter(name => matcher.test(name) && name !== '.git').map(name => [...parents, name].join('/'))
  } catch {
    warnings.push(`${entry}: directory not found`)
    return []
  }
}

/**
 * Copy the listed entries from `repoRoot` into `dest`.
 * @param repoRoot - main checkout directory.
 * @param dest - new worktree directory.
 * @param configured - the configured entry list.
 */
export async function copyIntoWorktree(repoRoot: string, dest: string, configured: readonly string[]): Promise<CopyOutcome> {
  const outcome: CopyOutcome = { copied: [], warnings: [] }
  const entries = [...new Set([...await readIncludeFile(repoRoot), ...configured.map(item => item.trim()).filter(item => item !== '')])]
  const rootAbs = resolve(repoRoot)
  const destAbs = resolve(dest)
  for (const entry of entries) {
    if (!isSafeRelativePath(entry)) {
      outcome.warnings.push(`${entry}: unsafe path`)
      continue
    }
    const segments = entry.replaceAll('\\', '/').split('/').filter(segment => segment !== '' && segment !== '.')
    for (const rel of await expand(repoRoot, segments, outcome.warnings, entry)) {
      const source = resolve(rootAbs, rel)
      const target = resolve(destAbs, rel)
      if (!inside(rootAbs, source) || !inside(destAbs, target) || rel === '.git' || rel.startsWith('.git/')) {
        outcome.warnings.push(`${rel}: outside the repository`)
        continue
      }
      let stats
      try {
        stats = await lstat(source)
      } catch {
        outcome.warnings.push(`${rel}: not found`)
        continue
      }
      if (stats.isSymbolicLink()) {
        outcome.warnings.push(`${rel}: symbolic link skipped`)
        continue
      }
      try {
        await lstat(target)
        outcome.warnings.push(`${rel}: already exists, kept`)
        continue
      } catch {
        // Target is free.
      }
      try {
        await mkdir(dirname(target), { recursive: true })
        if (stats.isDirectory()) {
          await cp(source, target, {
            recursive: true,
            force: false,
            errorOnExist: false,
            filter: async (item) => {
              if (item.split(sep).includes('.git')) return false
              return !(await lstat(item)).isSymbolicLink()
            },
          })
        } else {
          await copyFile(source, target, constants.COPYFILE_EXCL)
        }
        outcome.copied.push(rel)
      } catch (error) {
        outcome.warnings.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return outcome
}
