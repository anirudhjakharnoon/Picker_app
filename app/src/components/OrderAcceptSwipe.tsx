import { useEffect, useRef, useState } from 'react';

const ACCEPT_THRESHOLD = 0.72;

/**
 * Deliberate, touch-friendly acceptance affordance. A normal button makes it
 * too easy to accept an order accidentally while scrolling the offer list;
 * this requires a rightward swipe over most of the track. Pointer events keep
 * the behavior identical for mouse, touch, and stylus without a gesture
 * dependency, and a keyboard path (Enter/Space) keeps it operable without a
 * pointer.
 */
export function OrderAcceptSwipe({
  disabled = false,
  disabledMessage,
  label = 'Swipe right to accept',
  busyLabel = 'Working…',
  onAccepted,
}: {
  disabled?: boolean;
  disabledMessage?: string;
  label?: string;
  busyLabel?: string;
  // May be async; the swipe stays in its "busy" state until it settles, and
  // resets itself if the action fails so the user can retry.
  onAccepted: () => void | Promise<unknown>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const pointerStartX = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const trigger = () => {
    if (disabled || busy) return;
    setProgress(1);
    setBusy(true);
    // Previously the control latched "accepted" forever and never reset, so a
    // failed accept/handoff left the swipe stuck on "Working…" with no retry.
    // Await the action and reset on completion; on success the parent usually
    // unmounts this (navigates away), which the mounted guard handles.
    Promise.resolve(onAccepted())
      .catch(() => {})
      .finally(() => {
        if (!mounted.current) return;
        setBusy(false);
        setProgress(0);
      });
  };

  const finish = () => {
    const didAccept = progress >= ACCEPT_THRESHOLD;
    setDragging(false);
    pointerStartX.current = null;
    if (!didAccept) {
      setProgress(0);
      return;
    }
    trigger();
  };

  return (
    <div
      ref={trackRef}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={disabled ? disabledMessage ?? 'Unavailable' : label}
      className={`order-accept-swipe ${dragging ? 'is-dragging' : ''} ${disabled ? 'is-disabled' : ''} ${busy ? 'is-accepted' : ''}`}
      title={disabled ? disabledMessage : label}
      onKeyDown={(event) => {
        if (disabled || busy) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          trigger();
        }
      }}
      onPointerDown={(event) => {
        if (disabled || busy) return;
        pointerStartX.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (pointerStartX.current === null || !trackRef.current) return;
        const width = Math.max(trackRef.current.getBoundingClientRect().width - 54, 1);
        setProgress(Math.max(0, Math.min(1, (event.clientX - pointerStartX.current) / width)));
      }}
      onPointerUp={finish}
      onPointerCancel={() => {
        pointerStartX.current = null;
        setDragging(false);
        setProgress(0);
      }}
    >
      <span className="order-accept-fill" style={{ transform: `scaleX(${progress})` }} />
      <span className="order-accept-label">{busy ? busyLabel : disabled ? disabledMessage ?? 'Unavailable' : label}</span>
      <span className="order-accept-thumb" style={{ left: `calc(${progress * 100}% - ${progress * 54}px)` }} aria-hidden="true">
        ›
      </span>
    </div>
  );
}
