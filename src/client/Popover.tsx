/**
 * Anchored popover panel: portaled to the body, fixed-positioned under its
 * trigger by the primitives' anchor hook, dismissed by outside pointer or
 * Escape. The trigger element (`anchorRef`) counts as inside, so clicking it
 * toggles instead of reopening.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ui.module.css'

export interface PopoverProps {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  /** Localized accessible name of the panel. */
  label: string
  children: ReactNode
  /** Fixed panel width in px (default: content-driven within the CSS bounds). */
  width?: number
}

/**
 * Render a popover panel when open.
 * @param props - see {@link PopoverProps}.
 */
export function Popover({ open, anchorRef, onClose, label, children, width }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const position = useAnchoredPosition({ open, anchorRef, panelRef, side: 'bottom', align: 'start', gap: 4, margin: 8 })
  useDismissOnOutsidePointer(anchorRef, open, (next) => { if (!next) onClose() }, panelRef)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [open, onClose])

  if (!open) return null
  const style: CSSProperties = {
    ...(position ?? { left: 0, top: 0, visibility: 'hidden' }),
    ...(width === undefined ? {} : { width }),
  }
  return createPortal(
    <MenuSurface ref={panelRef} role="dialog" aria-label={label} className={css['panel']} style={style}>
      {children}
    </MenuSurface>,
    document.body,
  )
}
