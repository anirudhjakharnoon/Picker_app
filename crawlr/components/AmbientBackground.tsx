/**
 * Pure decorative CSS animation layer: scanline sweep, drifting grid glow,
 * and a marquee status ticker. No backend reads/writes ever happen here -
 * it runs continuously regardless of crawl state, and is entirely frozen
 * by the `prefers-reduced-motion` rule in globals.css (see `.ambient-layer`).
 */
export function AmbientBackground() {
  return (
    <div
      aria-hidden="true"
      className="ambient-layer pointer-events-none fixed inset-0 z-0 overflow-hidden"
    >
      <div className="bg-crt-grid absolute inset-0 opacity-60" />
      <div className="bg-vignette absolute inset-0" />

      <div className="absolute left-[-20%] top-[-10%] h-[60vh] w-[60vh] animate-drift rounded-full bg-signal-green/5 blur-3xl" />
      <div className="absolute bottom-[-15%] right-[-10%] h-[50vh] w-[50vh] animate-drift rounded-full bg-signal-cyan/5 blur-3xl [animation-delay:-4s]" />

      <div className="absolute inset-x-0 top-0 h-24 animate-scanline bg-gradient-to-b from-signal-green/10 via-signal-green/0 to-transparent" />

      <div className="absolute inset-0 opacity-[0.04] mix-blend-overlay">
        <div className="h-full w-full bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.5)_0px,transparent_1px,transparent_2px)]" />
      </div>
    </div>
  );
}
