"""End-to-end tests for the updater (updater.py + server.py's /update routes).

A fake GitHub API and a throwaway "upstream" git repo stand in for GitHub, so nothing touches the real repo, GitHub or a
running monitor. Each test copy of the monitor runs as a real server.py on a free port, with FRM pointed at nothing.

  python tests/test_update.py            # everything (about a minute); the tests build on each other's releases
  python tests/test_update.py --keep     # keep the temp folder with each server's console output

Covers: git and zip copies; up to date / update available / release notes; click-to-update (POST /update) and
--auto-update; the restart handing over to the new version; a broken release being undone; GitHub unreachable or
rate-limited (console line only, site keeps working); copies that mustn't be updated (uncommitted changes, another
branch, own commits); only this machine can start an update; files the repo doesn't ship stay untouched.
"""
import argparse
import http.server
import io
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import zipfile

SRC = pathlib.Path(__file__).resolve().parents[1]
REPO = "test/monitor"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def git(cwd, *args):
    r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, creationflags=NO_WINDOW)
    if r.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout.strip()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def fetch(method, url, headers=None, timeout=10):
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=b"" if method == "POST" else None)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def wait_for(fn, timeout=40, what="condition"):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:
            last = e
        time.sleep(0.3)
    raise AssertionError(f"timed out waiting for {what} (last: {last!r})")


# ---- fake GitHub -----------------------------------------------------------------------------
class FakeGitHub:
    """Serves /repos/<REPO>/{releases,tags,compare,zipball} from the upstream repo. mode: ok | offline | ratelimit | error"""

    def __init__(self, upstream):
        self.up, self.releases, self.mode, self.port, self.httpd = upstream, [], "ok", free_port(), None
        self.url = f"http://127.0.0.1:{self.port}"
        self.start()

    def start(self):
        fake = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, body, ctype="application/json"):
                body = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if fake.mode == "ratelimit":
                    return self.send(403, {"message": "API rate limit exceeded"})
                if fake.mode == "error":
                    return self.send(500, {"message": "oops"})
                if fake.mode == "garbage":
                    return self.send(200, b"<html>not json</html>", "text/html")
                path = self.path.partition("?")[0]
                base = f"/repos/{REPO}/"
                if not path.startswith(base):
                    return self.send(404, {"message": "Not Found"})
                rest = path[len(base):]
                if rest == "releases":
                    return self.send(200, fake.releases)
                if rest == "tags":
                    tags = [{"name": t, "commit": {"sha": git(fake.up, "rev-parse", f"{t}^{{commit}}")}}
                            for t in git(fake.up, "tag", "--sort=-creatordate").split()]
                    return self.send(200, tags)
                if rest.startswith("compare/"):
                    a, _, b = rest[len("compare/"):].partition("...")
                    try:
                        a, b = git(fake.up, "rev-parse", a + "^{commit}"), git(fake.up, "rev-parse", b + "^{commit}")
                    except RuntimeError:
                        return self.send(404, {"message": "Not Found"})
                    anc = lambda x, y: subprocess.run(["git", "-C", str(fake.up), "merge-base", "--is-ancestor", x, y],
                                                      creationflags=NO_WINDOW).returncode == 0
                    status = "identical" if a == b else "ahead" if anc(a, b) else "behind" if anc(b, a) else "diverged"
                    return self.send(200, {"status": status})
                if rest.startswith("zipball/"):
                    tag = rest[len("zipball/"):]
                    sha = git(fake.up, "rev-parse", tag + "^{commit}")
                    data = subprocess.run(["git", "-C", str(fake.up), "archive", "--format=zip",
                                           f"--prefix=test-monitor-{sha[:7]}/", tag], capture_output=True,
                                          creationflags=NO_WINDOW).stdout
                    return self.send(200, data, "application/zip")
                self.send(404, {"message": "Not Found"})

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def offline(self):   # nothing listening: connection refused, like no network
        self.httpd.shutdown()
        self.httpd.server_close()

    def online(self):
        self.start()

    def release(self, tag, body="", draft=False, prerelease=False):
        self.releases.insert(0, {"tag_name": tag, "name": f"Release {tag}", "body": body, "draft": draft,
                                 "prerelease": prerelease, "html_url": f"https://example.invalid/{tag}",
                                 "published_at": "2026-11-02T00:00:00Z", "zipball_url": f"{self.url}/repos/{REPO}/zipball/{tag}"})


# ---- the world: upstream repo, fake GitHub, copies of the monitor -------------------------------
class World:
    def __init__(self, keep=False):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="ficsit-update-test-"))
        self.keep, self.servers = keep, []
        self.up = self.tmp / "upstream"
        self.up.mkdir()
        # this working copy's files as they are now (tracked + new, not ignored), as release v1.0
        for rel in git(SRC, "ls-files", "-co", "--exclude-standard").splitlines():
            if rel.startswith("tests/") or not (SRC / rel).is_file():
                continue
            (self.up / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SRC / rel, self.up / rel)
        (self.up / "docs" / "old-note.txt").write_text("dropped in v1.2\n")
        (self.up / "release.txt").write_text("v1.0\n")
        git(self.up, "init", "-q", "-b", "main")
        git(self.up, "config", "user.email", "t@example.invalid")
        git(self.up, "config", "user.name", "test")
        git(self.up, "config", "core.autocrlf", "false")
        git(self.up, "add", "-A")
        git(self.up, "commit", "-q", "-m", "v1.0")
        git(self.up, "tag", "v1.0")
        self.gh = FakeGitHub(self.up)
        self.gh.release("v1.0", "First release")

    def publish(self, tag, body="", change=None):
        """Commit a change upstream, tag it and publish a release."""
        (self.up / "release.txt").write_text(tag + "\n")
        if change:
            change(self.up)
        git(self.up, "add", "-A")
        git(self.up, "commit", "-q", "-m", tag)
        git(self.up, "tag", tag)
        self.gh.release(tag, body)

    def git_copy(self, name, tag="v1.0"):
        d = self.tmp / name
        git(self.tmp, "clone", "-q", str(self.up), name)
        git(d, "config", "core.autocrlf", "false")
        git(d, "reset", "-q", "--hard", tag)
        return d

    def zip_copy(self, name, tag="v1.0"):
        d = self.tmp / name
        sha = git(self.up, "rev-parse", tag + "^{commit}")
        data = subprocess.run(["git", "-C", str(self.up), "archive", "--format=zip", f"--prefix=x-{sha[:7]}/", tag],
                              capture_output=True, creationflags=NO_WINDOW).stdout
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            z.extractall(self.tmp / (name + "-unzip"))
        shutil.move(str(self.tmp / (name + "-unzip") / f"x-{sha[:7]}"), str(d))
        return d

    def serve(self, copy, *args, host="127.0.0.1", first_check=3600):
        s = Server(self, copy, args, host, first_check)
        self.servers.append(s)
        return s

    def close(self):
        for s in self.servers:
            s.kill()
        self.gh.httpd.shutdown()
        if not self.keep:
            shutil.rmtree(self.tmp, ignore_errors=True)


class Server:
    def __init__(self, world, copy, args, host, first_check):
        self.copy, self.port = copy, free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.log = world.tmp / f"{copy.name}-{self.port}.log"
        env = {**os.environ, "FICSIT_UPDATE_REPO": REPO, "FICSIT_UPDATE_API": world.gh.url,
               "FICSIT_UPDATE_GIT": str(world.up), "FICSIT_UPDATE_FIRST_CHECK_S": str(first_check), "PYTHONUNBUFFERED": "1"}
        env.pop("FICSIT_BOOT", None)
        self.logf = open(self.log, "ab")
        self.proc = subprocess.Popen([sys.executable, str(copy / "server.py"), "--port", str(self.port), "--host", host,
                                      "--frm", "http://127.0.0.1:9", *args], cwd=str(copy), env=env,
                                     stdout=self.logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        self.pids = {self.proc.pid}
        wait_for(lambda: self.status(), 30, f"{copy.name} server to start")

    def status(self):
        code, body = fetch("GET", self.url + "/update/status", timeout=3)
        assert code == 200, code
        st = json.loads(body)
        self.pids.add(st["pid"])
        return st

    def post(self, path, header=True):
        code, body = fetch("POST", self.url + path, {"X-Ficsit-Update": "1"} if header else {}, timeout=60)
        return code, json.loads(body)

    def check(self):
        code, st = self.post("/update/check")
        assert code == 200, (code, st)
        return st

    def page_ok(self):
        code, body = fetch("GET", self.url + "/", timeout=5)
        return code == 200 and b"FICSIT" in body

    def output(self):
        self.logf.flush()
        return self.log.read_text(encoding="utf-8", errors="replace")

    def kill(self):
        for pid in self.pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        self.logf.close()


# ---- tests -----------------------------------------------------------------------------------
def wait_updated(srv, old_boot, version):
    def done():
        st = srv.status()
        return st if st["boot"] != old_boot and st["state"] == "idle" else None
    st = wait_for(done, 60, f"the new server ({version})")
    assert st["version"] == version, st["version"]
    return st


def test_git_up_to_date(w):
    c = w.git_copy("git-current")
    s = w.serve(c)
    st = s.check()
    assert st["mode"] == "git" and st["version"] == "v1.0" and st["latest"] == "v1.0", st
    assert not st["available"] and st["error"] is None, st
    w.gh.release("v1.0", "a draft", draft=True)            # drafts and pre-releases never count
    w.gh.releases[0]["tag_name"] = "v9.9"
    w.gh.release("v1.0", "a pre-release", prerelease=True)
    w.gh.releases[0]["tag_name"] = "v9.8"
    st = s.check()
    assert not st["available"] and st["latest"] == "v1.0", st
    w.gh.releases = w.gh.releases[2:]


def test_git_update_flow(w):
    c = w.git_copy("git-main")
    (c / "map.avif").write_bytes(b"game art")    # files the repo doesn't ship
    (c / "img").mkdir(exist_ok=True)
    (c / "img" / "x.png").write_bytes(b"icon")
    (c / "history.json").write_text('{"session": null, "power": [], "prod": [], "sink": []}')
    s = w.serve(c)
    w.publish("v1.1", "Faster maps\n- thing one", change=lambda up: (up / "js" / "added.js").write_text("// new in v1.1\n"))
    st = s.check()
    assert st["available"] and st["latest"] == "v1.1" and not st["blocked"], st
    assert [n["tag"] for n in st["notes"]] == ["v1.1"] and "Faster maps" in st["notes"][0]["body"], st["notes"]
    assert "v1.1 is out" in s.output()

    # needs the header (another website's page can't send it)
    code, j = s.post("/update", header=False)
    assert code == 403, (code, j)

    # uncommitted changes: left alone
    readme = c / "README.md"
    readme.write_text(readme.read_text() + "local edit\n")
    st = s.check()
    assert st["available"] and "uncommitted" in (st["blocked"] or ""), st
    code, j = s.post("/update")
    assert code == 409 and "uncommitted" in j["error"], (code, j)
    git(c, "checkout", "-q", "--", "README.md")

    # another branch: left alone
    git(c, "switch", "-q", "-c", "feature")
    st = s.check()
    assert "branch feature" in (st["blocked"] or ""), st
    git(c, "switch", "-q", "main")
    git(c, "branch", "-q", "-D", "feature")

    # untracked files are fine
    (c / "scratch.txt").write_text("mine")
    st = s.check()
    assert st["available"] and not st["blocked"], st

    old = st["boot"]
    code, j = s.post("/update")
    assert code == 202 and j["started"], (code, j)
    st = wait_updated(s, old, "v1.1")
    assert not st["available"], st
    assert (c / "release.txt").read_text().strip() == "v1.1" and (c / "js" / "added.js").exists()
    assert git(c, "rev-parse", "HEAD") == git(w.up, "rev-parse", "v1.1^{commit}")
    assert git(c, "symbolic-ref", "--short", "HEAD") == "main"
    assert (c / "map.avif").read_bytes() == b"game art" and (c / "img" / "x.png").read_bytes() == b"icon"
    assert (c / "scratch.txt").read_text() == "mine"
    assert (c / "laststate.json.gz").exists(), "state wasn't saved before the restart"
    s.proc.wait(10)   # the old server exited
    assert s.proc.returncode == 0, s.proc.returncode
    assert s.page_ok()
    assert "took over" in s.output(), s.output()


def test_git_own_commits(w):
    c = w.git_copy("git-ahead", "v1.0")
    git(c, "config", "user.email", "t@example.invalid")
    git(c, "config", "user.name", "test")
    (c / "mine.txt").write_text("local work")
    git(c, "add", "mine.txt")
    git(c, "commit", "-q", "-m", "local work")
    s = w.serve(c)
    st = s.check()
    assert st["available"] and "own commits" in (st["blocked"] or ""), st
    # a working copy ahead of the latest release (a developer's): nothing to do
    c2 = w.git_copy("git-dev", "v1.1")
    git(c2, "config", "user.email", "t@example.invalid")
    git(c2, "config", "user.name", "test")
    (c2 / "mine.txt").write_text("next release")
    git(c2, "add", "mine.txt")
    git(c2, "commit", "-q", "-m", "work")
    st = w.serve(c2).check()
    assert not st["available"] and not st["blocked"], st


def test_github_unreachable(w):
    c = w.git_copy("git-offline", "v1.0")
    s = w.serve(c)
    for mode, words in (("offline", "can't reach GitHub"), ("ratelimit", "HTTP 403"), ("error", "HTTP 500"),
                        ("garbage", "unexpected")):
        if mode == "offline":
            w.gh.offline()
        else:
            w.gh.mode = mode
        st = s.check()
        assert st["error"] and words in st["error"], (mode, st["error"])
        assert st["state"] == "idle", st
        assert s.page_ok(), "page broke while GitHub was unreachable"
        code, _ = fetch("GET", s.url + "/js/update.js")
        assert code == 200
        assert f"[update] check failed: {st['error']}" in s.output(), s.output()[-500:]
        code, j = s.post("/update")    # nothing known to update to
        assert code == 409, (code, j)
        if mode == "offline":
            w.gh.online()
        w.gh.mode = "ok"
    st = s.check()   # back online: the error clears
    assert st["error"] is None and st["available"], st


def test_git_broken_release_rolls_back(w):
    c = w.git_copy("git-rollback", "v1.1")
    s = w.serve(c)
    w.publish("v1.3", "broken", change=lambda up: (up / "server.py").write_text(
        "raise SystemExit(3)\n" + (up / "server.py").read_text(encoding="utf-8"), encoding="utf-8"))
    st = s.check()
    assert st["available"] and st["latest"] == "v1.3", st
    boot = st["boot"]
    code, j = s.post("/update")
    assert code == 202, (code, j)
    st = wait_for(lambda: (lambda x: x if x["state"] == "failed" else None)(s.status()), 60, "the update to fail")
    assert st["boot"] == boot, "a different server answered"
    assert "went back" in st["message"] and "exit code 3" in st["message"], st["message"]
    assert git(c, "rev-parse", "HEAD") == git(w.up, "rev-parse", "v1.1^{commit}")
    assert (c / "release.txt").read_text().strip() == "v1.1"
    assert git(c, "status", "--porcelain", "--untracked-files=no") == ""
    assert s.page_ok() and s.proc.poll() is None
    # pull the broken release (as you would on GitHub) so later tests see a good latest
    w.gh.releases = [r for r in w.gh.releases if r["tag_name"] != "v1.3"]
    git(w.up, "tag", "-d", "v1.3")
    git(w.up, "reset", "-q", "--hard", "v1.2" if "v1.2" in git(w.up, "tag").split() else "v1.1")


def test_zip_auto_update(w):
    c = w.zip_copy("zip-auto", "v1.0")
    assert (c / "VERSION").read_text().strip() == git(w.up, "rev-parse", "v1.0^{commit}"), "export-subst didn't fill VERSION"
    (c / "map.avif").write_bytes(b"game art")
    (c / "history.json").write_text('{"session": null, "power": [], "prod": [], "sink": []}')
    s = w.serve(c, "--auto-update", first_check=1)
    st = wait_updated(s, s.status()["boot"], "v1.1")    # nobody clicked anything
    assert st["mode"] == "zip" and st["auto"] and not st["available"], st
    assert (c / "release.txt").read_text().strip() == "v1.1" and (c / "js" / "added.js").exists()
    assert (c / "map.avif").read_bytes() == b"game art"
    assert (c / ".update-files").exists() and (c / "docs" / "old-note.txt").exists()
    assert "auto-updating" in s.output()


def test_zip_update_and_rollback(w):
    c = w.zip_copy("zip-main", "v1.1")
    s = w.serve(c)
    # v1.2 drops a file. A zip copy that never updated has no list of the files it got, so it can't know to remove
    # it yet; the next release after that can.
    st = s.check()
    assert not st["available"] and st["version"] == "v1.1", st
    w.publish("v1.2", "Drops old-note", change=lambda up: (up / "docs" / "old-note.txt").unlink())
    st = s.check()
    assert st["available"] and st["latest"] == "v1.2", st
    code, j = s.post("/update")
    assert code == 202, (code, j)
    wait_updated(s, st["boot"], "v1.2")
    assert (c / "release.txt").read_text().strip() == "v1.2"
    assert (c / ".update-files").exists()
    assert (c / "docs" / "old-note.txt").exists(), "no file list before this update: nothing is removed"
    w.publish("v1.2.1", "Drops another", change=lambda up: (up / "js" / "added.js").unlink())
    st = s.check()
    code, j = s.post("/update")
    assert code == 202, (code, j)
    wait_updated(s, st["boot"], "v1.2.1")
    assert not (c / "js" / "added.js").exists(), "a file the release dropped wasn't removed"
    assert (c / "docs" / "old-note.txt").exists(), "only files the last update wrote may be removed"

    # a broken release: undone, files back as they were
    before = {p: p.read_bytes() for p in (c / "server.py", c / "release.txt", c / "VERSION")}
    w.publish("v1.3", "broken", change=lambda up: (up / "server.py").write_text(
        "raise SystemExit(3)\n" + (up / "server.py").read_text(encoding="utf-8"), encoding="utf-8"))
    st = s.check()
    boot = st["boot"]
    assert s.post("/update")[0] == 202
    st = wait_for(lambda: (lambda x: x if x["state"] == "failed" else None)(s.status()), 60, "the zip update to fail")
    assert st["boot"] == boot and "went back" in st["message"], st
    assert all(p.read_bytes() == b for p, b in before.items()), "files weren't restored"
    assert not (c / "js" / "added.js").exists()
    assert s.page_ok() and st["version"] == "v1.2.1", st
    w.gh.releases = [r for r in w.gh.releases if r["tag_name"] != "v1.3"]
    git(w.up, "tag", "-d", "v1.3")
    git(w.up, "reset", "-q", "--hard", "v1.2.1")


def test_only_this_machine(w):
    try:   # this machine's LAN address (no packets are sent)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as u:
            u.connect(("10.255.255.255", 1))
            lan = u.getsockname()[0]
    except OSError:
        lan = None
    if not lan or lan.startswith("127."):
        print("    (skipped: no LAN address)")
        return
    c = w.git_copy("git-lan", "v1.0")
    s = w.serve(c, host="0.0.0.0")
    code, body = fetch("POST", f"http://{lan}:{s.port}/update/check", {"X-Ficsit-Update": "1"})
    assert code == 403 and b"computer running" in body, (code, body)
    code, body = fetch("GET", f"http://{lan}:{s.port}/update/status")
    assert code == 200 and json.loads(body)["canApply"] is False
    assert s.status()["canApply"] is True


def test_zip_checks(w):
    """The zip download is checked before anything is written."""
    sys.path.insert(0, str(SRC))
    import updater
    sha = "a" * 40

    def mk(files):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as z:
            for n, d in files.items():
                z.writestr(n, d)
        return b.getvalue()
    assert updater._zip_files(mk({"top/VERSION": sha + "\n", "top/js/a.js": "x"}), sha) == {"VERSION": (sha + "\n").encode(), "js/a.js": b"x"}
    for bad in ({"top/VERSION": "b" * 40}, {"top/VERSION": sha, "top/../evil.py": "x"}, {"top/VERSION": sha, "other/x": "x"},
                {"top/VERSION": sha, "top/.git/config": "x"}, {"top/VERSION": sha, "top/.update-files": "x"}):
        try:
            updater._zip_files(mk(bad), sha)
        except updater.UpdateError:
            continue
        raise AssertionError(f"accepted a bad zip: {list(bad)}")


ORDER = [test_zip_checks, test_git_up_to_date, test_git_update_flow, test_git_own_commits, test_github_unreachable,
         test_git_broken_release_rolls_back, test_zip_auto_update, test_zip_update_and_rollback, test_only_this_machine]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="keep the temp folder (server logs) afterwards")
    a = ap.parse_args()
    w = World(keep=a.keep)
    failed = 0
    try:
        for t in ORDER:
            t0 = time.monotonic()
            try:
                t(w)
                print(f"ok    {t.__name__}  ({time.monotonic() - t0:.1f} s)")
            except Exception:
                failed += 1
                print(f"FAIL  {t.__name__}")
                traceback.print_exc()
    finally:
        w.close()
        if a.keep or failed:
            print(f"temp folder: {w.tmp}")
    print("all passed" if not failed else f"{failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
