// Every repeating fetch goes through every(), so the page goes easy on the game server (FRM answers most calls on
// the game thread):
//  - a page in the background (another browser tab, minimised window) polls at most once a minute;
//  - a poll with a when() test is skipped while nothing on screen needs it (the power network with no power map open);
//  - wakePolls() catches up whatever fell behind as soon as it's needed again (page shown, tab switched).
// The charts don't mind the slow-down: their history is recorded by server.py, not by the page.
"use strict";

const BACKGROUND_MS = 60000;
const polls = new Set();

function every(fn, ms, when) {
  const p = { ms, last: Date.now(), h: 0 };   // callers fetch once themselves right before starting the timer
  p.run = () => { if (when && !when()) return; p.last = Date.now(); fn(); };
  p.arm = (delay = document.hidden ? Math.max(ms, BACKGROUND_MS) : ms) => {
    clearTimeout(p.h); p.h = setTimeout(() => { p.arm(); p.run(); }, delay);
  };
  p.stop = () => { clearTimeout(p.h); polls.delete(p); };
  polls.add(p); p.arm();
  return p;
}
const stopPoll = p => p && p.stop();

function wakePolls() {
  for (const p of polls) {
    const wait = p.last + (document.hidden ? Math.max(p.ms, BACKGROUND_MS) : p.ms) - Date.now();
    if (wait > 0) p.arm(wait); else { p.arm(); p.run(); }
  }
}
document.addEventListener("visibilitychange", wakePolls);
