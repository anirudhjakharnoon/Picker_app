import clsx from "clsx";

export type AppPhase = "target" | "setup" | "running" | "result";

const STAGES: Array<{ key: AppPhase; label: string; matches: AppPhase[] }> = [
  { key: "target", label: "01 · Target", matches: ["target"] },
  { key: "setup", label: "02 · Scope", matches: ["setup"] },
  { key: "running", label: "03 · Run", matches: ["running", "result"] },
];

export function ProgressRail({ phase }: { phase: AppPhase }) {
  return (
    <nav className="flex items-center gap-0 border-b border-signal-green/15 bg-void-950/80 px-4 py-3 backdrop-blur">
      <div className="mr-4 flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-signal-green shadow-glow" />
        <span className="font-display text-lg font-bold tracking-tight text-signal-green text-glow">
          CRAWLR
        </span>
      </div>
      <ol className="flex flex-1 items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em]">
        {STAGES.map((stage, i) => {
          const active = stage.matches.includes(phase);
          return (
            <li key={stage.key} className="flex items-center gap-2">
              {i > 0 && <span className="text-signal-green/20">──</span>}
              <span
                className={clsx(
                  "border px-2.5 py-1",
                  active
                    ? "border-signal-green text-signal-green shadow-glow"
                    : "border-signal-green/15 text-signal-green/35",
                )}
              >
                {stage.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
