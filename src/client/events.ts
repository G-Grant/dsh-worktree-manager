/**
 * Cross-component change notice: any component that mutated git state
 * (switch, create, merge, remove) emits it, every status reader refreshes.
 * A DOM event keeps the components decoupled and survives hot reloads.
 */

const EVENT = 'dsh-worktree-manager:changed'

/** Announce that git state changed. */
export function emitChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(EVENT))
}

/**
 * Listen for change notices.
 * @param listener - invoked on every notice.
 * @returns the disposer.
 */
export function onChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(EVENT, listener)
  return () => { window.removeEventListener(EVENT, listener) }
}
