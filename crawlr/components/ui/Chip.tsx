import type { ReactNode } from "react";
import clsx from "clsx";

interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}

export function Chip({ active, onClick, children, disabled }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={clsx(
        "border px-3 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-signal-green bg-signal-green/15 text-signal-green shadow-glow"
          : "border-signal-green/20 text-signal-green/50 hover:border-signal-green/50 hover:text-signal-green/80",
      )}
    >
      {active ? "[x] " : "[ ] "}
      {children}
    </button>
  );
}
