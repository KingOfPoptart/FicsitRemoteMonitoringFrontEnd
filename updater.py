"""Update check and one-click update for the FICSIT monitor, from the project's GitHub releases.

Only published releases count (not drafts or pre-releases); commits pushed to main without a release are never offered.
- A git checkout updates with `git merge --ff-only <release tag>`. It's left alone when it has uncommitted changes, its
  own commits, or is on a branch other than main (it's someone's working copy).
- A copy downloaded as a zip downloads the release zip and copies its files over this folder. VERSION says which commit
  it is (GitHub fills it in when it builds the zip: .gitattributes export-subst). .update-files lists the files the last
  update wrote, so the next one can remove files a release dropped.
Files the repo doesn't ship (history.json, laststate.json.gz, map.avif, img/) are never touched.

After updating, the server saves its state, starts the new version and exits. If the new version doesn't answer within
RESTART_WAIT_S, the update is undone and the old server carries on.
A failed check (no network, GitHub down or rate-limited) only prints a line on the console; the site isn't affected.
"""
import io
import json
import os
import pathlib
import re
import secrets
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).parent
# Overridable for tests (a fake GitHub API and a local git repo)
REPO = os.environ.get("FICSIT_UPDATE_REPO", "KingOfPoptart/FicsitRemoteMonitoringFrontEnd")
API = os.environ.get("FICSIT_UPDATE_API", "https://api.github.com").rstrip("/")
GIT_URL = os.environ.get("FICSIT_UPDATE_GIT", f"https://github.com/{REPO}.git")
FIRST_CHECK_S = float(os.environ.get("FICSIT_UPDATE_FIRST_CHECK_S", 20))
CHECK_EVERY_S = 6 * 3600
RETRY_S = 3600              # after a failed check
RESTART_WAIT_S = 30         # how long the new server gets to answer before the update is undone
MAX_ZIP = 100 << 20
VERSION_FILE = ROOT / "VERSION"
MANIFEST = ROOT / ".update-files"
TAG_FILE = ROOT / ".update-tag"   # "<tag> <commit>" of the release the last zip update installed (its name before a check)
BACKUP = ROOT / ".update-backup"
NO_WINDOW = 0x08000000 if os.name == "nt" else 0   # git calls: no console window flashing up

# Set by the server that started this one after an update: this server answers /update/status with it, which tells
# the old one the new one is up. Not passed on to whatever this one starts.
BOOT = os.environ.pop("FICSIT_BOOT", None)
RESTARTED = BOOT is not None
BOOT = BOOT or secrets.token_hex(8)

S = {"enabled": True, "auto": False, "mode": None, "version": None, "commit": None, "latest": None, "available": False,
     "blocked": None, "notes": [], "checked": None, "error": None, "state": "idle", "message": None}
_rel = {}                    # the latest release: tag, sha, zip URL
_lock = threading.Lock()     # one check or update at a time
_cfg = {}                    # set by configure(): httpd(), save(), url
_failed = set()              # release commits whose update failed: --auto-update doesn't retry them
RESUME = threading.Event()   # an update was undone: the server's main loop serves again


class UpdateError(Exception):
    pass


def log(msg):
    print(f"[update] {msg}", flush=True)


# ---- git and GitHub --------------------------------------------------------------------------
def _git(*args, timeout=60):
    try:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, timeout=timeout,
                              env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}, creationflags=NO_WINDOW)
    except FileNotFoundError:
        raise UpdateError("git isn't installed (or isn't on PATH)")
    except subprocess.TimeoutExpired:
        raise UpdateError(f"git {args[0]} took too long")


def git(*args, timeout=60):
    r = _git(*args, timeout=timeout)
    if r.returncode:
        lines = (r.stderr or r.stdout).strip().splitlines()
        raise UpdateError(f"git {args[0]}: {lines[-1] if lines else 'failed'}")
    return r.stdout.strip()


def is_ancestor(a, b):
    return _git("merge-base", "--is-ancestor", a, b).returncode == 0


def _roots_only():
    """Windows: an SSL context trusting only the Windows *root* store. Python's default also trusts the intermediate
    ("CA") store, and Windows can keep a cross-signed copy of a root there (e.g. USERTrust ECC signed by Comodo's AAA
    Certificate Services) whose own issuer isn't installed: OpenSSL then builds the chain through it and fails with
    "unable to get issuer certificate" (seen with api.github.com). Stricter than the default, not looser."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)   # verifies certificates and host names
    n = 0
    for der, enc, trust in ssl.enum_certificates("ROOT"):
        if enc == "x509_asn" and (trust is True or "1.3.6.1.5.5.7.3.1" in trust):   # trusted for server auth
            try:
                ctx.load_verify_locations(cadata=der)
                n += 1
            except ssl.SSLError:
                pass
    return ctx if n else None


def urlopen(req, timeout):
    """urlopen that copes with the Windows certificate-store problem above: roots only first, then Python's default."""
    if os.name == "nt":
        try:
            ctx = _roots_only()
        except Exception:
            ctx = None
        if ctx:
            try:
                return urllib.request.urlopen(req, timeout=timeout, context=ctx)
            except urllib.error.URLError as e:
                if not isinstance(e.reason, ssl.SSLCertVerificationError):
                    raise
    return urllib.request.urlopen(req, timeout=timeout)


def api(path):
    req = urllib.request.Request(API + path, headers={"Accept": "application/vnd.github+json", "User-Agent": "FICSIT-Monitor",
                                                      "X-GitHub-Api-Version": "2022-11-28"})
    with urlopen(req, timeout=15) as r:
        return json.load(r)


def why(e):
    """A failed check or update, in one line."""
    if isinstance(e, urllib.error.HTTPError):
        if e.code in (403, 429):
            return f"GitHub said no (HTTP {e.code}, probably its limit of 60 checks an hour; tries again later)"
        return f"GitHub answered HTTP {e.code}"
    if isinstance(e, urllib.error.URLError):
        return f"can't reach GitHub ({e.reason})"
    if isinstance(e, (TimeoutError, OSError)):
        return f"can't reach GitHub ({e})"
    if isinstance(e, ValueError):
        return f"GitHub sent something unexpected ({e})"
    return str(e)


# ---- this copy -------------------------------------------------------------------------------
def local():
    """Which version this copy is: mode (git/zip), commit, a readable version."""
    if (ROOT / ".git").exists():
        commit = git("rev-parse", "HEAD")
        return {"mode": "git", "commit": commit, "version": git("describe", "--tags", "--always", "--dirty")}
    try:
        txt = VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        txt = ""
    commit = txt if re.fullmatch(r"[0-9a-f]{40}", txt) else None
    try:
        tag, sha = TAG_FILE.read_text(encoding="utf-8").split()
    except (OSError, ValueError):
        tag, sha = None, None
    version = tag if commit and sha == commit else commit[:7] if commit else "unknown"
    return {"mode": "zip", "commit": commit, "version": version}


def git_blocker():
    """Why this git checkout shouldn't be updated (None = fine)."""
    branch = _git("symbolic-ref", "--quiet", "--short", "HEAD").stdout.strip()   # empty when detached
    if branch and branch != "main":
        return f"this copy is on branch {branch}, not main"
    gitdir = pathlib.Path(git("rev-parse", "--absolute-git-dir"))
    if any((gitdir / f).exists() for f in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply")):
        return "this copy is in the middle of a merge or rebase"
    if git("status", "--porcelain", "--untracked-files=no"):
        return "this copy has uncommitted changes"
    return None


# ---- checking --------------------------------------------------------------------------------
def _check():
    """Ask GitHub for the latest release and compare it with this copy. Raises on any failure."""
    info = local()
    releases = [r for r in api(f"/repos/{REPO}/releases?per_page=20") if not r.get("draft") and not r.get("prerelease")]
    info.update(latest=None, available=False, blocked=None, notes=[])
    if not releases:
        return info
    tags = {t["name"]: t["commit"]["sha"] for t in api(f"/repos/{REPO}/tags?per_page=100")}
    rels = [(r, tags[r["tag_name"]]) for r in releases if r.get("tag_name") in tags]
    if not rels:
        raise UpdateError("the latest release's tag isn't on GitHub")
    latest, lsha = rels[0]
    info["latest"] = latest["tag_name"]
    _rel.update(tag=latest["tag_name"], sha=lsha, zip=latest.get("zipball_url"))
    head = info["commit"]
    newer = lambda sha: sha != head   # the releases this copy doesn't have yet (worked out per mode below)

    if info["mode"] == "git":
        if head != lsha:
            tag = latest["tag_name"]
            git("fetch", "--quiet", "--no-tags", GIT_URL, f"+refs/tags/{tag}:refs/tags/{tag}", timeout=120)
            if git("rev-parse", f"refs/tags/{tag}^{{commit}}") != lsha:
                raise UpdateError(f"{tag} from git isn't the commit GitHub's API says it is")
            if is_ancestor(lsha, head):
                pass   # this copy already has it (a working copy ahead of the release)
            elif is_ancestor(head, lsha):
                info.update(available=True, blocked=git_blocker())
            else:
                info.update(available=True, blocked=f"this copy has its own commits that aren't in {tag}")
            newer = lambda sha: sha != head and not is_ancestor(sha, head)
    else:
        for r, sha in rels:
            if sha == head:
                info["version"] = r["tag_name"]
                break
        if head is None:
            info.update(available=True, blocked="can't tell which version this copy is (no VERSION file): download the "
                                                "latest release from GitHub once by hand")
        elif head != lsha:
            try:
                status = api(f"/repos/{REPO}/compare/{head}...{lsha}").get("status")
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    raise
                status = "unknown"   # a commit GitHub doesn't know: take the release anyway
            info["available"] = status not in ("behind", "identical")

    if info["available"]:
        for r, sha in rels[:10]:
            if not newer(sha):
                break
            info["notes"].append({"tag": r["tag_name"], "name": r.get("name") or r["tag_name"], "date": r.get("published_at"),
                                  "url": r.get("html_url"), "body": (r.get("body") or "").strip()[:800]})
    return info


def check():
    """Check GitHub now. Never raises: a failure is a line on the console and S["error"]. True = it worked."""
    if not _lock.acquire(blocking=False):   # an update (or another check) is running
        return False
    try:
        was = S["latest"], S["available"]
        try:
            info = _check()
        except Exception as e:
            S["error"] = why(e)
            log(f"check failed: {S['error']}")
            return False
        S.update(info, error=None, checked=time.time())
        if info["available"] and (info["latest"], True) != was:
            log(f"{info['latest']} is out (this is {info['version']})" +
                (f"; not updating: {info['blocked']}" if info["blocked"] else
                 "" if S["auto"] else "; click Update in the page header to install it"))
        return True
    finally:
        _lock.release()


def status(local_client):
    d = {k: S[k] for k in ("enabled", "auto", "mode", "version", "commit", "latest", "available", "blocked", "notes",
                           "checked", "error", "state", "message")}
    d.update(boot=BOOT, pid=os.getpid(), canApply=local_client)
    return d


# ---- updating --------------------------------------------------------------------------------
def start_apply(auto=False):
    """Start an update in the background. Returns (started, reason)."""
    if S["state"] in ("updating", "restarting"):
        return False, "an update is already running"
    if not S["available"]:
        return False, "no update available"
    if S["blocked"]:
        return False, f"not updating: {S['blocked']}"
    S.update(state="updating", message=f"Updating to {S['latest']}")
    threading.Thread(target=_apply, args=(auto,), daemon=True).start()
    return True, None


def _apply(auto):
    try:
        with _lock:
            info = _check()   # GitHub again, right before: what's latest now, and is this copy still OK to update
            S.update(info, error=None, checked=time.time())
            if not info["available"]:
                raise UpdateError("no update available")
            if info["blocked"]:
                raise UpdateError(f"not updating: {info['blocked']}")
            tag, sha = _rel["tag"], _rel["sha"]
            log(f"{'auto-' if auto else ''}updating {info['version']} -> {tag}")
            undo = _apply_git(sha) if info["mode"] == "git" else _apply_zip(_rel["zip"], sha, tag)
    except Exception as e:
        _rel_sha = _rel.get("sha")
        if _rel_sha:
            _failed.add(_rel_sha)
        S.update(state="failed", message=f"Update failed: {why(e)}")
        log(S["message"])
        return
    _restart(undo, tag, sha)


def _apply_git(sha):
    prev = git("rev-parse", "HEAD")
    git("merge", "--ff-only", "--quiet", sha, timeout=120)
    return lambda: git("reset", "--keep", prev)


def _download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "FICSIT-Monitor", "Accept": "application/vnd.github+json"})
    with urlopen(req, timeout=60) as r:
        data = r.read(MAX_ZIP + 1)
    if len(data) > MAX_ZIP:
        raise UpdateError("the release zip is too big")
    return data


def _zip_files(data, sha):
    """{relative path: bytes} from a GitHub release zip (everything sits in one top folder)."""
    zf = zipfile.ZipFile(io.BytesIO(data))
    names = [n for n in zf.namelist() if not n.endswith("/")]
    top = names[0].split("/")[0] + "/" if names else ""
    files = {}
    for n in names:
        rel = n[len(top):] if n.startswith(top) else None
        parts = rel.split("/") if rel else []
        if not rel or any(p in ("", ".", "..") or ":" in p or "\\" in p for p in parts) or parts[0] in (".git", BACKUP.name, MANIFEST.name, TAG_FILE.name):
            raise UpdateError(f"the release zip has an unexpected file in it ({n})")
        files[rel] = zf.read(n)
    if files.get("VERSION", b"").decode("utf-8", "replace").strip() != sha:
        raise UpdateError("the downloaded zip isn't the release it should be (its VERSION doesn't match)")
    return files


def _read(p):
    try:
        return p.read_text(encoding="utf-8")
    except OSError:
        return None


def _apply_zip(url, sha, tag):
    if not url:
        raise UpdateError("the release has no zip")
    files = _zip_files(_download(url), sha)
    old_manifest, old_tag = _read(MANIFEST), _read(TAG_FILE)
    removed = {f for f in (old_manifest or "").splitlines() if f and f not in files and (ROOT / f).is_file()}
    shutil.rmtree(BACKUP, ignore_errors=True)
    saved, created = [], []

    def undo():
        for rel in saved:
            (ROOT / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(BACKUP / rel, ROOT / rel)
        for rel in created:
            (ROOT / rel).unlink(missing_ok=True)
        for p, old in ((MANIFEST, old_manifest), (TAG_FILE, old_tag)):
            if old is None:
                p.unlink(missing_ok=True)
            else:
                p.write_text(old, encoding="utf-8")

    try:
        for rel in sorted(removed | set(files)):   # keep a copy of everything about to change, to undo with
            p = ROOT / rel
            if p.is_file():
                (BACKUP / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, BACKUP / rel)
                saved.append(rel)
            else:
                created.append(rel)
        for rel, data in files.items():
            p = ROOT / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".update-tmp")
            tmp.write_bytes(data)
            os.replace(tmp, p)
        for rel in removed:
            (ROOT / rel).unlink()
        MANIFEST.write_text("\n".join(sorted(files)) + "\n", encoding="utf-8")
        TAG_FILE.write_text(f"{tag} {sha}\n", encoding="utf-8")
    except Exception:
        undo()
        raise
    return undo


def _std(f):
    try:
        f.flush()
        return f.fileno()
    except Exception:
        return None


def _restart(undo, tag, sha):
    """Hand over to the new version: save, stop serving, start it, wait for it to answer. Undo if it doesn't."""
    S.update(state="restarting", message=f"Restarting with {tag}")
    try:
        _cfg["save"]()
    except Exception as e:
        log(f"couldn't save state before restarting: {e}")
    httpd = _cfg["httpd"]()
    httpd.shutdown()
    httpd.server_close()
    token = secrets.token_hex(8)
    child, why_failed = None, None
    try:
        child = subprocess.Popen([sys.executable, str(ROOT / "server.py"), *sys.argv[1:]], cwd=os.getcwd(),
                                 env={**os.environ, "FICSIT_BOOT": token}, stdin=subprocess.DEVNULL,
                                 stdout=_std(sys.stdout), stderr=_std(sys.stderr))
        deadline = time.monotonic() + RESTART_WAIT_S
        while time.monotonic() < deadline:
            if child.poll() is not None:
                why_failed = f"the new version stopped at start (exit code {child.returncode})"
                break
            try:
                with urllib.request.urlopen(_cfg["url"] + "/update/status", timeout=2) as r:
                    if json.load(r).get("boot") == token:
                        log(f"updated to {tag}; the new server took over (this one is done)")
                        sys.stdout.flush()
                        os._exit(0)
            except Exception:
                pass
            time.sleep(0.5)
        else:
            why_failed = f"the new version didn't answer within {RESTART_WAIT_S} s"
    except Exception as e:
        why_failed = f"couldn't start the new version ({e})"
    if child and child.poll() is None:
        child.kill()
        child.wait()
    try:
        undo()
        back = "went back to the version before"
    except Exception as e:
        back = f"and going back failed too ({e}): fix it by hand"
    _failed.add(sha)
    S.update(state="failed", message=f"Update to {tag} failed: {why_failed}; {back}")
    S.update(local())
    log(S["message"])
    RESUME.set()   # the main loop serves again, with this (old) code still loaded


# ---- running ---------------------------------------------------------------------------------
def configure(httpd, save, url):
    _cfg.update(httpd=httpd, save=save, url=url)


def run(enabled=True, auto=False):
    """Background thread: check soon after start, then every few hours. Never raises."""
    S.update(enabled=enabled, auto=auto)

    def loop():
        try:
            S.update(local())
        except Exception as e:
            log(f"can't tell which version this is: {why(e)}")
        if not enabled:
            return
        time.sleep(FIRST_CHECK_S)
        while True:
            ok = check()
            if ok and auto and S["available"] and not S["blocked"] and _rel.get("sha") not in _failed:
                start_apply(auto=True)
            time.sleep(CHECK_EVERY_S if ok else RETRY_S)

    threading.Thread(target=loop, daemon=True).start()
