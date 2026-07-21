import { useEffect, useState } from 'react';
import { offlineDb } from './offlineDb';
import { onSync, pendingActionCount } from './syncEngine';

/** Live count of queued-but-not-yet-synced actions, for the sync-status indicator. */
export function usePendingCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void pendingActionCount().then((c) => {
        if (mounted) setCount(c);
      });
    };
    refresh();

    const unsubscribeSync = onSync(refresh);
    offlineDb.pendingActions.hook('creating', refresh);
    const interval = window.setInterval(refresh, 5000);

    return () => {
      mounted = false;
      unsubscribeSync();
      offlineDb.pendingActions.hook('creating').unsubscribe(refresh);
      window.clearInterval(interval);
    };
  }, []);

  return count;
}
