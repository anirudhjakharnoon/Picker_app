import { useEffect, type ReactNode } from 'react';
import { CloseIcon } from './icons';

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
  children,
}: {
  onClose?: () => void;
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
      <div className="fullscreen-content">{children}</div>
    </div>
  );
}
