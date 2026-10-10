// Keeps the screen on while any part of the app asks for it, where the
// browser allows it.

const holders = new Set();
let lock = null;

export async function holdScreen(holder, on) {
  if (on) holders.add(holder);
  else holders.delete(holder);
  try {
    if (holders.size > 0) lock ??= await navigator.wakeLock?.request('screen');
    else {
      await lock?.release();
      lock = null;
    }
  } catch {
    // Not critical.
  }
}
