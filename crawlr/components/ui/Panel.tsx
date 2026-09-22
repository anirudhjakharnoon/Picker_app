import type { ReactNode } from "react";
import clsx from "clsx";

interface PanelProps {
  title?: string;
  eyebrow?: string;
  children: ReactNode;
  className?: string;
  glow?: boolean;
}

/** The recurring "terminal card" shell: hairline border, corner ticks, optional glow. */
export function Panel({ title, eyebrow, children, className, glow }: PanelProps) {
  return (
    <section
      className={clsx(
        "relative border border-signal-green/20 bg-void-900/60 backdrop-blur-sm",
        glow && "shadow-glow",
        className,
      )}
    >
      <CornerTicks />
      {(title || eyebrow) && (
        <header className="flex items-baseline justify-between border-b border-signal-green/15 px-4 py-2.5">
          {eyebrow && (
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-signal-green/50">
              {eyebrow}
            </span>
          )}
          {title && (
            <h2 className="font-display text-sm font-medium uppercase tracking-wide text-signal-green">
              {title}
            </h2>
          )}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

function CornerTicks() {
  return (
    <>
      <span className="absolute -left-px -top-px h-2.5 w-2.5 border-l border-t border-signal-green/60" />
      <span className="absolute -right-px -top-px h-2.5 w-2.5 border-r border-t border-signal-green/60" />
      <span className="absolute -bottom-px -left-px h-2.5 w-2.5 border-b border-l border-signal-green/60" />
      <span className="absolute -bottom-px -right-px h-2.5 w-2.5 border-b border-r border-signal-green/60" />
    </>
  );
}
