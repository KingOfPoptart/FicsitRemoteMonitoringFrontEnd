// Update button in the header, next to Reset layout. server.py checks GitHub releases (updater.py); this shows when
// a newer one is out and installs it on click: the server restarts and the page reloads by itself.
// Anything going wrong here (server busy, GitHub unreachable) is a console warning only: the page carries on.
"use strict";

const Update = (() => {
  const btn = document.getElementById("updateBtn");
  let st = null, pageCommit = null, waiting = null, lastWarn = null;

  async function fetchStatus() {
    const r = await fetch("/update/status", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function notes(s) {
    return s.notes.map(n => `${n.name}${n.body ? "\n" + n.body : ""}`).join("\n\n");
  }

  function show(label, title, cls, onClick) {
    btn.hidden = false;
    btn.textContent = label;
    btn.title = title;
    btn.className = "b hdr-btn update " + (cls || "");
    btn.onclick = onClick;
  }

  function render() {
    const s = st;
    if (!s) return;
    if (pageCommit && s.commit && s.commit !== pageCommit && s.state !== "restarting")   // the server was updated under this page
      return show("Updated · reload", `The monitor was updated to ${s.version}. Reload the page to use it.`, "ready", () => location.reload());
    if (s.state === "updating" || s.state === "restarting" || waiting)
      return show("Updating…", s.message || "Installing the update; the page reloads by itself when it's done.", "busy", null);
    if (s.state === "failed")
      return show("Update failed", s.message + (s.canApply ? "\n\nClick to try again." : ""), "bad", s.canApply && s.available && !s.blocked ? start : null);
    if (!s.available) { btn.hidden = true; return; }
    if (s.blocked)
      return show(`${s.latest} out`, `${s.latest} is out (this is ${s.version}), but it won't be installed here: ${s.blocked}.\n\n${notes(s)}`, "muted", null);
    if (!s.canApply)
      return show(`${s.latest} out`, `${s.latest} is out (this is ${s.version}). Install it from the computer running the monitor.\n\n${notes(s)}`, "muted", null);
    show(`Update to ${s.latest}`, `${s.latest} is out (this is ${s.version}). Click to install it: the monitor restarts for a few seconds and this page reloads.\n\n${notes(s)}`, "", start);
  }

  async function refresh() {
    try {
      st = await fetchStatus();
    } catch (e) {
      if (!waiting) console.warn("update status unavailable:", e.message);
      return;
    }
    if (pageCommit === null) pageCommit = st.commit;
    if (st.error && st.error !== lastWarn) console.warn("update check failed:", st.error);   // server-side; the site's fine
    lastWarn = st.error;
    render();
  }

  async function start() {
    if (!confirm(`Install ${st.latest}?\n\nThe monitor restarts (a few seconds) and this page reloads.`)) return;
    let r, j;
    try {
      r = await fetch("/update", { method: "POST", headers: { "X-Ficsit-Update": "1" } });
      j = await r.json();
    } catch (e) {
      console.warn("update didn't start:", e.message);
      return;
    }
    if (!r.ok) { alert("The update didn't start: " + (j.error || r.status)); return refresh(); }
    const from = st.boot, until = Date.now() + 90000;
    waiting = true; render();
    // wait for a different server (new boot id) on the new version, or for the old one to report it failed
    const tick = async () => {
      let s = null;
      try { s = await fetchStatus(); } catch { /* restarting: nobody answering for a moment */ }
      if (s && s.boot !== from && s.state === "idle") { location.reload(); return; }
      if (s && s.boot === from && s.state === "failed") { waiting = null; st = s; render(); alert(s.message); return; }
      if (Date.now() > until) {
        waiting = null; st = s || st;
        show("Update failed", "No answer from the monitor after the update. Check the window it runs in.", "bad", () => location.reload());
        return;
      }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  }

  refresh();
  every(refresh, 5 * 60 * 1000);
  return { refresh };
})();
