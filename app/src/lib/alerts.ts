// Picker alerting: a short chime + optional OS notification + haptic when a new
// order is assigned. All of it is best-effort and must never throw into the UI.

let audioCtx: AudioContext | null = null;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * Create/resume the AudioContext. Browsers only allow audio to start from a
 * user gesture, so call this from one (e.g. the picker tapping "go online").
 */
export function primeAudio(): void {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch {
    /* audio is a nice-to-have; ignore */
  }
}

/** A two-note "ding-dong" so a picker notices a new order without looking. */
export function playChime(): void {
  try {
    primeAudio();
    if (!audioCtx) return;
    const ctx = audioCtx;
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.32, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.2);
    });
  } catch {
    /* ignore */
  }
}

/** Short haptic buzz on devices that support it. */
export function buzz(): void {
  try {
    navigator.vibrate?.([180, 90, 180]);
  } catch {
    /* ignore */
  }
}

/** Ask for OS notification permission once, on a user gesture. */
export async function requestNotificationPermission(): Promise<void> {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') await Notification.requestPermission();
  } catch {
    /* ignore */
  }
}

/** Fire an OS notification for a newly-assigned order, if permitted. */
export function notifyNewOrder(title: string, body: string): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(title, {
      body,
      tag: 'dbo-new-order',
      icon: '/pwa-192.png',
      badge: '/pwa-192.png',
    });
    window.setTimeout(() => n.close(), 8000);
  } catch {
    /* ignore */
  }
}

/** Convenience: fire everything for a new order. */
export function alertNewOrder(title: string, body: string): void {
  playChime();
  buzz();
  notifyNewOrder(title, body);
}
