import { useEffect, type ReactNode } from 'react';
import { CloseIcon } from './icons';
import type { Toast } from '../lib/useToast';

/**
 * A fullscreen, non-scrolling overlay used for every camera-scanning screen
 * and its immediate result screens (docs: "the scanner page should fill one
 * page for mobile and shouldn't require scroll"). It:
 *   - covers the entire viewport (including the app-level hamburger menu, so
 *     there is no separate "hide chrome" mechanism to maintain — there is
 *     simply nothing behind this overlay to see or scroll to),
 *   - locks background scroll while mounted,
 *   - shows one clearly visible close (X) button, top-right.
 */
export function FullscreenSheet({
  onClose,
  toast,
  children,
}: {
  onClose?: () => void;
  /**
   * The shared toast message (if any), rendered as a visible banner inside
   * this sheet. This overlay used to have no toast rendering of its own —
   * error/status notifications (e.g. "Wrong bag, bag does not belong to the
   * hole") were only ever rendered on the main queue screen, so they were
   * completely invisible while any scanner screen was open. Every caller
   * must pass its current toast value through for errors to actually be
   * seen during scanning.
   */
  toast?: Toast | null;
  children: ReactNode;
}) {
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  return (
    <div className="fullscreen-sheet">
      {onClose && (
        <button
          type="button"
          className="icon-button fullscreen-close"
          aria-label="Close"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      )}
      {toast && (
        <div className={`toast fullscreen-toast is-${toast.variant}`} role="alert">
          {toast.text}
        </div>
      )}
      <div className="fullscreen-content">{children}</div>
    </div>
  );
}
