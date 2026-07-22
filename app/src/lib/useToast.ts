import { useCallback, useRef, useState } from 'react';

export type ToastVariant = 'info' | 'success' | 'error';

export interface Toast {
  text: string;
  variant: ToastVariant;
}

/**
 * Shared toast state with a severity so a failure never looks like a
 * confirmation. `notify(text)` defaults to an informational toast; pass
 * `'success'` or `'error'` to colour it (green / red) via the `.toast.is-*`
 * classes. Errors persist longer than successes since a missed failure on a
 * busy floor is costly.
 */
export function useToast(defaultTimeoutMs = 4000) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const notify = useCallback(
    (text: string, variant: ToastVariant = 'info') => {
      setToast({ text, variant });
      window.clearTimeout(timer.current);
      const ms = variant === 'error' ? Math.max(defaultTimeoutMs, 6000) : defaultTimeoutMs;
      timer.current = window.setTimeout(() => setToast(null), ms);
    },
    [defaultTimeoutMs],
  );

  return { toast, notify };
}
