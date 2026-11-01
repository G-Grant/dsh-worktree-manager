/**
 * Repository status of one directory as a React hook: loaded on mount and on
 * directory change, refreshed when the window regains focus and whenever any
 * component of this plugin announces a change.
 */

import { useCallback, useEffect, useState } from 'react'
import type { RepoStatus } from '../wire.ts'
import { fetchStatus } from './api.ts'
import { onChanged } from './events.ts'

/** Status facts of a git directory (the `repo: true` arm). */
export type RepoFacts = Extract<RepoStatus, { repo: true }>

/**
 * Track the repository facts of a directory.
 * @param cwd - absolute directory, or undefined while unknown.
 * @returns the facts (null for a non-git directory or a failed load) and a refresh verb.
 */
export function useRepoStatus(cwd: string | undefined): readonly [RepoFacts | null, () => Promise<void>] {
  const [facts, setFacts] = useState<RepoFacts | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (cwd === undefined) {
      setFacts(null)
      return
    }
    const result = await fetchStatus(cwd)
    setFacts(result.ok && result.repo ? result : null)
  }, [cwd])

  useEffect(() => {
    let live = true
    setFacts(null)
    if (cwd !== undefined) {
      void fetchStatus(cwd).then((result) => {
        if (live) setFacts(result.ok && result.repo ? result : null)
      })
    }
    return () => { live = false }
  }, [cwd])

  useEffect(() => {
    const refresh = (): void => { void load() }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    const dispose = onChanged(refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
      dispose()
    }
  }, [load])

  return [facts, load]
}
