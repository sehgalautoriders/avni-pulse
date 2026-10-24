"""Connect AVNI Pulse (WP-0067) to Release Control as its own Stage 2 target: AVNI-PULSE, chain avni-pulse.

The same road AVNI Architect (WP-0064) and AVNI Windows Task Manager (WP-0065) took: through the release module, under the release
authority (the pipe's own key, read the way avni_release.py release reads it - Directive 0035). The target entry itself was written on
24-10-2026 with a copy of targets.json kept before the change (targets.json.bak-<time>-before-avni-pulse); this script only adds it when
it is missing, then sets the SET-PRODUCTION baseline ("nothing installed yet" = the first commit, a69b66c, README only - which is also
exactly what GitHub served when the repository was made). Running it twice changes nothing.

    python tools/register_target.py
"""
import datetime as dt
import io
import os
import shutil
import subprocess
import sys

SENTINEL_TOOLS = r"C:\02 - OUR FILES\Access to all drives\AVNI\90 - WORKTREES\Active\WP-0038 - AVNI SENTINEL\tools"
sys.path.insert(0, SENTINEL_TOOLS)
import avni_release as rel  # noqa: E402

REPO = r"C:\02 - OUR FILES\Access to all drives\AVNI\90 - WORKTREES\Active\WP-0067 - AVNI PULSE"
TID, CHAIN = "AVNI-PULSE", "avni-pulse"
INSTALLED = r"C:\02 - OUR FILES\Access to all drives\AVNI\Release Control\Installed\AVNI-PULSE.json"


def phase(name):
    return [{"type": "cmd", "argv": [
        "pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
        "{staging}\\" + CHAIN + "\\tools\\release\\Pulse-Release.ps1",
        "-Phase", name, "-Rc", "{rc}", "-Staging", "{staging}", "-Build", "{build}",
        "-Commit", "{candidate[" + CHAIN + "]}", "-RcRoot", "{rc_root}"]}]


TARGET = {
    "title": ("AVNI Pulse - our own Slido (Ravi 24-10-2026 19:42 GO; planned 08-10-2026): live polls, anonymous Q&A with upvotes, word "
              "cloud, timed quiz with leaderboard, survey, participation counts. Stage 2 web application on GitHub Pages "
              "(sehgalautoriders/avni-pulse, docs/ on main); live state in Supabase Sehgal Hero (pulse_* functions + realtime counter). "
              "Presenter screen host.html opens inside AVNI.exe (its row is a Stage 1 job); phones join with a code or QR, no sign-in. "
              "Released only by its own tools/release/Pulse-Release.ps1."),
    "stage": 2,
    "version_format": "AVNI Pulse r{n}",
    "chains": {CHAIN: {"repo": REPO, "branch": "main", "advance": True}},
    "installed": [{"chain": CHAIN, "type": "json-key", "file": INSTALLED, "key": "commit"}],
    "identity": [{"type": "json-value", "json": INSTALLED, "key": "commit", "equals": "{commit[" + CHAIN + "]}"}],
    "road_test": True,
    "clean_staging": True,
    "executor": {p: phase(p) for p in ("build", "test", "snapshot", "install", "verify", "rollback")},
}


def main():
    if not rel.is_authority() and os.path.isfile(rel.KEY):
        os.environ["AVNI_RELEASE_AUTHORITY"] = io.open(rel.KEY, encoding="utf-8").read().strip()   # the pipe's own mechanics (Directive 0035)
    rel.need_authority("register AVNI-PULSE")
    t = rel.targets()
    if TID in t["targets"]:
        print(f"{TID} is already connected in {rel.TARGETS}")
    else:
        bak = rel.TARGETS + f".bak-{dt.datetime.now():%d-%m-%Y_%H%M}-before-avni-pulse"
        shutil.copy2(rel.TARGETS, bak)
        t["targets"][TID] = TARGET
        rel.write_json(rel.TARGETS, t)
        print(f"{TID} connected in {rel.TARGETS} (copy before the change: {bak})")
    first = subprocess.run(["git", "-C", REPO, "rev-list", "--max-parents=0", "main"], capture_output=True, text=True, check=True).stdout.split()[0]
    con = rel.connect()
    con.execute("PRAGMA busy_timeout = 180000")   # other chats' releases hold the book for minutes on a busy evening (24-10-2026)
    with rel.Tx(con):
        p = con.execute("SELECT commit_sha FROM production WHERE target=? AND chain=?", (TID, CHAIN)).fetchone()
        if not p:
            con.execute("INSERT INTO production(target, chain, commit_sha, release_id, version, at) VALUES (?,?,?,?,?,?)",
                        (TID, CHAIN, first, "BASELINE", None, rel.now()))
            rel.log(con, "SET-PRODUCTION", f"{TID}/{CHAIN}", True, f"{first} (new application registered; nothing installed yet)")
            print(f"baseline {TID}/{CHAIN} = {first[:10]} (nothing installed yet)")
        else:
            print(f"baseline already set: {p['commit_sha'][:10]}")
        rel.log(con, "NEW-TARGET", TID, True, f"AVNI Pulse <- {REPO} @main (WP-0067)")
        rel.mirror(con)
    return 0


if __name__ == "__main__":
    sys.exit(main())
