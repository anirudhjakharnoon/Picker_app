import { useEffect, useRef, useState, type ReactNode } from 'react';

const THRESHOLD = 68; // px of pull needed to trigger a refresh
const MAX = 96; // clamp so the indicator never grows unbounded

/**
 * Lightweight pull-to-refresh for the picker screens. The app disables the
 * browser's native overscroll (see styles.css), so this provides the familiar
 * "pull down at the top to reload" gesture on touch devices. It only engages
 * when the page is scrolled to the very top and the finger moves down, so it
 * never fights normal scrolling or the horizontal accept-swipe.
 */
export function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
}) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const s = { startY: null as number | null, dist: 0, active: false, busy: false };

    const reset = () => {
      s.startY = null;
      s.dist = 0;
      s.active = false;
      setPull(0);
    };

    const onStart = (e: TouchEvent) => {
      if (s.busy || e.touches.length !== 1) {
        s.startY = null;
        return;
      }
      s.startY = (scroller.scrollTop || 0) <= 0 ? e.touches[0].clientY : null;
      s.active = false;
    };

    const onMove = (e: TouchEvent) => {
      if (s.startY === null || s.busy) return;
      const dy = e.touches[0].clientY - s.startY;
      if (dy <= 0) return;
      if ((scroller.scrollTop || 0) > 0) {
        reset();
        return;
      }
      s.active = true;
      s.dist = Math.min(MAX, dy * 0.5); // resistance
      setPull(s.dist);
      if (e.cancelable) e.preventDefault(); // hold the page still while pulling
    };

    const onEnd = () => {
      if (!s.active) {
        s.startY = null;
        return;
      }
      const shouldRefresh = s.dist >= THRESHOLD;
      s.startY = null;
      s.active = false;
      if (shouldRefresh) {
        s.busy = true;
        setRefreshing(true);
        setPull(THRESHOLD);
        Promise.resolve(onRefreshRef.current()).finally(() => {
          s.busy = false;
          s.dist = 0;
          setRefreshing(false);
          setPull(0);
        });
      } else {
        reset();
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  const visible = pull > 0 || refreshing;
  return (
    <>
      <div className="ptr-indicator" aria-hidden={!visible} style={{ height: pull, opacity: visible ? 1 : 0 }}>
        <span
          className={`ptr-spinner${refreshing ? ' is-spinning' : ''}`}
          style={refreshing ? undefined : { transform: `rotate(${Math.min(180, pull * 2.6)}deg)` }}
        />
        <span className="ptr-label">
          {refreshing ? 'Refreshing…' : pull >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh'}
        </span>
      </div>
      {children}
    </>
  );
}
