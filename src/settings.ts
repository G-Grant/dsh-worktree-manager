/**
 * Host-side settings support: resolve the worktree storage root and validate
 * the stored value.
 */

import { join } from 'node:path'
import { isAbsoluteConfigPath } from './normalize.js'

/**
 * Resolve the dsh configuration home: `$DSH_HOME` when set (a blank value
 * counts as unset), else `~/.dsh`.
 * @param home - user home directory (`os.homedir()` seam).
 * @param envHome - `$DSH_HOME` environment value seam.
 */
export function resolveDshHome(home: string, envHome: string | undefined): string {
  return typeof envHome === 'string' && envHome.trim() !== '' ? envHome : join(home, '.dsh')
}

/**
 * Resolve the effective worktree storage root: an explicit non-blank
 * `rootDir` wins, otherwise `<dsh home>/worktrees`.
 * @param rootDir - settings-resolved value (absent / blank = default).
 * @param home - user home directory seam.
 * @param envHome - `$DSH_HOME` seam.
 */
export function resolveRootDir(rootDir: string | undefined, home: string, envHome: string | undefined): string {
  const configured = rootDir?.trim()
  if (configured !== undefined && configured !== '') return configured
  return join(resolveDshHome(home, envHome), 'worktrees')
}

/**
 * Reject a stored rootDir the plugin could not act on: a non-blank value that
 * is not an absolute path. Blank / absent means the default and passes.
 * @param rootDir - settings-resolved value.
 */
export function validateRootDir(rootDir: string | undefined): void {
  if (rootDir === undefined) return
  const trimmed = rootDir.trim()
  if (trimmed === '') return
  if (!isAbsoluteConfigPath(trimmed)) throw new Error(`rootDir "${rootDir}" is not an absolute path`)
}
