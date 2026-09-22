import type { ButtonHTMLAttributes } from "react";
import clsx from "clsx";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "danger";
}

export function Button({ variant = "ghost", className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={clsx(
        "relative inline-flex items-center justify-center gap-2 border px-4 py-2 font-mono text-xs uppercase tracking-[0.15em] transition-all duration-150",
        "disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" &&
          "border-signal-green bg-signal-green/10 text-signal-green shadow-glow hover:bg-signal-green/20 active:scale-[0.98]",
        variant === "ghost" &&
          "border-signal-green/25 text-signal-green/80 hover:border-signal-green/60 hover:text-signal-green",
        variant === "danger" &&
          "border-signal-red/40 text-signal-red hover:border-signal-red hover:shadow-glow-red",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
