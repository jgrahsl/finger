// Keeps the screen on while any part of the app asks for it, where the
// browser allows it.

const holders = new Set();
let lock = null;
let busy = false;

// Brings the lock in line with the holders. Runs one request at a time and
// looks again afterwards, since holders can change while a request is pending.
async function sync() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const wanted = holders.size > 0 && !document.hidden;
      if (wanted && !lock) {
        const acquired = await navigator.wakeLock?.request('screen');
        if (!acquired) break; // not supported
        lock = acquired;
        // The browser drops the lock itself when the page is hidden.
        acquired.addEventListener('release', () => {
          if (lock === acquired) lock = null;
        });
      } else if (!wanted && lock) {
        const held = lock;
        lock = null;
        await held.release();
      } else break;
    }
  } catch {
    // Not critical.
  } finally {
    busy = false;
  }
}

export function holdScreen(holder, on) {
  if (on) holders.add(holder);
  else holders.delete(holder);
  return sync();
}

// A lock lost while the page was hidden has to be asked for again.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sync);
