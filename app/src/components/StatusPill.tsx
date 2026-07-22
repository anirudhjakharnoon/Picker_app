import type { StatusMeta } from '../lib/status';

/**
 * A functional status pill: tinted fill + saturated ink + a reinforcing dot,
 * driven by a StatusMeta ({ label, tone }). Colour signals meaning at a glance
 * on a busy floor; the label keeps it accessible without relying on colour.
 */
export function StatusPill({ meta, className }: { meta: StatusMeta; className?: string }) {
  return (
    <span className={`state-pill tone-${meta.tone}${className ? ` ${className}` : ''}`}>
      {meta.label}
    </span>
  );
}
