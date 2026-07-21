import { useRef, useState } from 'react';

const ACCEPT_THRESHOLD = 0.72;

/**
 * Deliberate, touch-friendly acceptance affordance. A normal button makes it
 * too easy to accept an order accidentally while scrolling the offer list;
 * this requires a rightward swipe over most of the track. Pointer events keep
 * the behavior identical for mouse, touch, and stylus without a gesture
 * dependency.
 */
export function OrderAcceptSwipe({
  disabled = false,
  disabledMessage,
  onAccepted,
}: {
  disabled?: boolean;
  disabledMessage?: string;
  onAccepted: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const pointerStartX = useRef<number | null>(null);

  const finish = () => {
    const didAccept = progress >= ACCEPT_THRESHOLD;
    setDragging(false);
    pointerStartX.current = null;
    if (!didAccept) {
      setProgress(0);
      return;
    }
    setProgress(1);
    setAccepted(true);
    onAccepted();
  };

  return (
    <div
      ref={trackRef}
      className={`order-accept-swipe ${dragging ? 'is-dragging' : ''} ${disabled ? 'is-disabled' : ''} ${accepted ? 'is-accepted' : ''}`}
      aria-disabled={disabled}
      title={disabled ? disabledMessage : 'Swipe right to accept order'}
      onPointerDown={(event) => {
        if (disabled || accepted) return;
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
      <span className="order-accept-label">{accepted ? 'Accepting…' : disabled ? 'Current order in progress' : 'Swipe right to accept'}</span>
      <span className="order-accept-thumb" style={{ left: `calc(${progress * 100}% - ${progress * 54}px)` }} aria-hidden="true">
        ›
      </span>
    </div>
  );
}
