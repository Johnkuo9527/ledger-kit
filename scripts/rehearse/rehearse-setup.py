#!/usr/bin/env python3
"""Rehearse scripts/setup.sh end to end, like a person typing in a real terminal.

    npm run rehearse:setup                     (from the repository folder)
    python3 scripts/rehearse/rehearse-setup.py [--bash /path/to/bash] [--keep] [--only NAME]

Each scenario copies this working tree to a temporary folder (node_modules are linked, not copied),
writes a made-up seed/accounts.json, and runs the wizard in a pseudo-terminal against the FAKE wrangler
(scripts/rehearse/fake-wrangler.cjs: no network, no Cloudflare). A scripted person answers each prompt
the moment the wizard waits on it; then the scenario checks what the wizard left behind.

--bash runs the wizard under another bash: macOS ships bash 3.2, so run it once with a 3.2 build
before changing setup.sh (empty arrays under `set -u`, `${var,,}`, `declare -A`, `mapfile` all break 3.2).

Python 3 standard library only. Unix only (pty).
"""
import argparse
import json
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

REPO = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))
FAKE = os.path.join(REPO, "scripts", "rehearse", "fake-wrangler.cjs")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\([A-Z0-9]|\x1b[=>]|\x1b\][^\x07]*\x07")
HEX64 = re.compile(r"\b[0-9a-f]{64}\b")
STALL_SECONDS = 90

# ── Made-up people and banks (never real data) ─────────────────────────────────────────────
ALEX_ACCOUNTS = {
    "banks": [{"institution": "spree", "name": "Spree Bank", "domains": ["spreebank.example"]}],
    "accounts": [
        {"id": "spree-visa", "institution": "spree", "kind": "credit_card", "name": "Spree Visa 1234",
         "last4": "1234", "currency": "EUR", "wallet_names": []},
        {"id": "cash", "institution": "cash", "kind": "cash", "name": "Cash", "last4": None,
         "currency": "EUR", "alerts_expected": False, "has_statements": False},
    ],
}
MEI_ACCOUNTS = {
    "banks": [{"institution": "formosa", "name": "福爾摩沙範例銀行", "domains": ["formosa-bank.example"]}],
    "accounts": [
        {"id": "formosa-card", "institution": "formosa", "kind": "credit_card", "name": "範例卡 5678",
         "last4": "5678", "currency": "TWD", "wallet_names": []},
        {"id": "cash", "institution": "cash", "kind": "cash", "name": "現金", "last4": None,
         "currency": "TWD", "alerts_expected": False, "has_statements": False},
    ],
}

# ── The person: (name, prompt the wizard is waiting on, what they type) ────────────────────
# A prompt matches only at the very end of what the wizard printed since the last answer, so
# an instruction line that merely mentions a word is never mistaken for a question.
def person(home, reader="subscription", tests="n", subdomain="y", subdomain_name=None,
           owner_email="owner@example.invalid", pdf_locked="n", keep=False):
    """keep: press Enter at every remembered answer (home, language, reader) instead of typing it."""
    ccy, tz, cc, lang = ("", "", "", "") if keep else home
    reader = "" if keep else reader
    rules = [
        ("start", r"Ready to start\?", ""),
        ("tests", r"Run the tests now[^\n]*\[y/N\]", tests),
        ("reader", r"Type subscription or api[^\n]*:", reader),
        ("currency", r"\n  Currency[^\n]*:", ccy),
        ("timezone", r"\n  Time zone[^\n]*:", tz),
        ("country", r"\n  Country[^\n]*:", cc),
        ("language", r"Language, en or zh-Hant[^\n]*:", lang),
        ("paid-plan", r"Press Enter when your account is on Workers Paid\.", ""),
        ("other-account", r"Sign in with a DIFFERENT Cloudflare account instead\?[^\n]*\[y/N\]", "n"),
        ("migrations", r"continue\? › \(Y/n\)", "y"),
        ("register-subdomain", r"register a workers\.dev subdomain now\? › \(Y/n\)", subdomain),
        ("subdomain-name", r"subdomain to be\?[^\n]*› ", subdomain_name or ""),
        ("address", r"Your ledger's address[^\n]*:", ""),
        ("keys-saved", r"Saved both in your password manager\?[^\n]*\)\.", ""),
        ("owner-email", r"Email address for the sign-in codes[^\n]*:", owner_email),
        ("owner-email-ok", r"is that exactly right\?[^\n]*\[y/N\]", "y"),
        ("resend-key", r"the Resend API key[\s\S]*Enter a secret value: … ", "re_FAKE_PLACEHOLDER"),
        ("google-ready", r"Press Enter when you have the Client ID and Client secret\.", ""),
        ("client-id", r"the Client ID[\s\S]*Enter a secret value: … ", "fake-id.apps.googleusercontent.com"),
        ("client-secret", r"the Client secret[\s\S]*Enter a secret value: … ", "FAKE-CLIENT-SECRET"),
        ("api-key", r"Anthropic API key[\s\S]*Enter a secret value: … ", "sk-ant-FAKE"),
        ("pdf-locked", r"locked with a password\?[^\n]*:", pdf_locked),
        ("pdf-password", r"statement PDF password[\s\S]*Enter a secret value: … ", "FAKE-PDF-PW"),
        ("keep-secret", r"is already set\. (Replace it|Make a new one)[^\n]*\[y/N\]", "n"),
        ("enter", r"Press Enter to continue\.?", ""),
    ]
    return [(n, re.compile(p + r"(?: \[Enter keeps current\])?[ \t]*$"), a) for n, p, a in rules]


def make_kit(root, accounts):
    kit = os.path.join(root, "kit")
    files = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           cwd=REPO, check=True, capture_output=True).stdout.decode().split("\0")
    for f in filter(None, files):
        src = os.path.join(REPO, f)
        if not os.path.isfile(src):
            continue
        dst = os.path.join(kit, f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
    # The template, never an installed copy: a filled wrangler.toml would make the wizard ask
    # "replace it?" questions this rehearsal does not script.
    toml = open(os.path.join(kit, "wrangler.toml"), encoding="utf8").read()
    if "REPLACE-WITH-YOUR-D1-DATABASE-ID" not in toml:
        toml = subprocess.run(["git", "show", "HEAD:wrangler.toml"], cwd=REPO, check=True, capture_output=True).stdout.decode()
        open(os.path.join(kit, "wrangler.toml"), "w", encoding="utf8").write(toml)
    for d in ("", "worker"):
        os.symlink(os.path.join(REPO, d, "node_modules"), os.path.join(kit, d, "node_modules"))
    with open(os.path.join(kit, "seed", "accounts.json"), "w", encoding="utf8") as fh:
        json.dump(accounts, fh, ensure_ascii=False, indent="\t")
    return kit


def run_wizard(kit, state, rules, bash, extra_env=None):
    """Run setup.sh in a pty, answering by the rules. Returns (exit code, transcript, answered names)."""
    env = dict(os.environ, TERM="xterm-256color", FAKE_STATE=state, LEDGER_SETUP_NO_BROWSER="1",
               LEDGER_SETUP_WRANGLER=f"node --no-warnings {FAKE}", **(extra_env or {}))
    env.pop("CI", None)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(kit)
        os.execvpe(bash, [bash, "scripts/setup.sh"], env)
    window, transcript, answered = "", "", []
    last = time.time()
    while True:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                data = os.read(fd, 65536).decode("utf8", "replace")
            except OSError:
                break
            if not data:
                break
            clean = ANSI.sub("", data).replace("\r", "")
            window += clean
            transcript += clean
            last = time.time()
            continue
        for name, pat, ans in rules:
            if pat.search(window):
                os.write(fd, (ans + "\n").encode())
                answered.append(name)
                shown = ans if name not in ("resend-key", "client-secret", "api-key", "pdf-password") else "[made-up secret]"
                transcript += f"\n<<typed ({name}): {shown!r}>>\n"
                window = ""
                last = time.time()
                break
        if time.time() - last > STALL_SECONDS:
            transcript += f"\n<<STALLED: no prompt this person knows; last screen:>>\n{window[-600:]}\n"
            os.kill(pid, 9)
            break
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    return code, HEX64.sub("[64-hex key]", transcript), answered


# ── Checks ────────────────────────────────────────────────────────────────────────────────
class Failed(Exception):
    pass


def check(cond, what):
    if not cond:
        raise Failed(what)


def setup_state(kit):
    p = os.path.join(kit, ".setup-state")
    return open(p, encoding="utf8").read() if os.path.exists(p) else ""


def fake(state):
    return json.load(open(os.path.join(state, "state.json"), encoding="utf8"))


def toml_var(kit, key):
    m = re.search(rf'^{key} = "(.*)"$', open(os.path.join(kit, "wrangler.toml"), encoding="utf8").read(), re.M)
    return m.group(1) if m else None


def wrangler_calls(state):
    p = os.path.join(state, "wrangler.log")
    return open(p, encoding="utf8").read().splitlines() if os.path.exists(p) else []


ALL_SECRETS = {"LEDGER_UNLOCK_KEY", "LEDGER_SESSION_SECRET", "LEDGER_SHORTCUT_KEY", "LEDGER_OWNER_EMAIL",
               "RESEND_API_KEY", "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"}


def finished_install(kit, state, out, address, home, owner_email="owner@example.invalid"):
    ccy, tz, cc, lang = home
    check("Setup complete" in out, "the wizard did not reach ✓ Setup complete")
    check(setup_state(kit).count("LEDGER_ADDRESS=") == 1 and f"LEDGER_ADDRESS={address}\n" in setup_state(kit),
          f"remembered address is not exactly {address}")
    summary = re.search(r"remembered for the next run:[^\n]*", out)
    check(summary and summary.group(0).split().count("LEDGER_ADDRESS") == 1, "the summary does not name LEDGER_ADDRESS exactly once")
    check((toml_var(kit, "LEDGER_HOME_CURRENCY"), toml_var(kit, "LEDGER_TIMEZONE"), toml_var(kit, "LEDGER_HOME_COUNTRY"), toml_var(kit, "LEDGER_LANGUAGE")) == (ccy, tz, cc, lang),
          "wrangler.toml does not hold the home and language typed")
    s = fake(state)
    check(ALL_SECRETS <= set(s["secrets"]), f"secrets missing: {sorted(ALL_SECRETS - set(s['secrets']))}")
    check(s["secrets"]["LEDGER_OWNER_EMAIL"]["len"] == len(owner_email), "LEDGER_OWNER_EMAIL is not the address typed")
    for key in ("LEDGER_UNLOCK_KEY", "LEDGER_SESSION_SECRET", "LEDGER_SHORTCUT_KEY"):
        check(s["secrets"][key]["len"] == 64, f"{key} is not a 64-character key")
    check("Using fallback value in non-interactive context" not in out, "wrangler ran without a terminal and answered a question by itself")
    check(all("stdoutTTY=true" in line for line in wrangler_calls(state) if ":: wrangler deploy" in line),
          "the deploy ran without a terminal (its subdomain question would answer itself 'no')")
    check(not re.search(r"\n\s+at .+\(.*:\d+:\d+\)", out), "a stack trace reached the screen")
    check(address in out.split("Setup complete", 1)[1], "the closing screen does not show the ledger's address")


def scenario_new_account_en(root, bash):
    """A brand-new Cloudflare account (no workers.dev subdomain yet), English, euro; then a re-run."""
    home = ("EUR", "Europe/Berlin", "DE", "en")
    kit, state = make_kit(root, ALEX_ACCOUNTS), os.path.join(root, "cloudflare")
    code, out, said = run_wizard(kit, state, person(home, tests="y", subdomain_name="example"), bash)
    yield "first run", out
    check(code == 0, f"exit {code}")
    check("register-subdomain" in said and "subdomain-name" in said, "wrangler never asked for a workers.dev subdomain")
    finished_install(kit, state, out, "https://ledger.example.workers.dev", home)
    check("All tests pass" in out, "the tests did not run or did not pass")
    seed = json.load(open(os.path.join(kit, "seed", "accounts.json"), encoding="utf8"))
    check(seed["banks"][0].get("pdf_password") is False, "answering 'not locked' did not write \"pdf_password\": false")
    check("LEDGER_PDF_PW_SPREE" not in fake(state)["secrets"], "a PDF password was set for a bank whose PDFs are not locked")
    check("Connect Gmail" in out and "連接 Gmail" not in out, "the English closing screen does not name the English button")
    check(toml_var(kit, "LEDGER_CATEGORIES").startswith("Food,"), "an English install lost the English categories")
    puts_before = sum(":: wrangler secret put" in l for l in wrangler_calls(state))
    deploys_before = fake(state)["deploys"]

    code, out, said = run_wizard(kit, state, person(home), bash)
    yield "re-run", out
    check(code == 0, f"re-run exit {code}")
    check(sum(":: wrangler secret put" in l for l in wrangler_calls(state)) == puts_before, "the re-run replaced a secret nobody asked to replace")
    check("No migrations to apply" in out, "the re-run did not skip the applied migrations")
    check("register-subdomain" not in said, "the re-run asked for a subdomain again")
    check(fake(state)["deploys"] == deploys_before + 1, "the re-run did not deploy once")
    finished_install(kit, state, out, "https://ledger.example.workers.dev", home)

    # A ZIP user's update: a fresh download, with only seed/accounts.json and .setup-state carried over
    # (INSTALL.md "Later"). Enter and "n" alone must rebuild wrangler.toml from the account and the memory.
    new = make_kit(os.path.join(root, "update"), ALEX_ACCOUNTS)
    shutil.copy2(os.path.join(kit, "seed", "accounts.json"), os.path.join(new, "seed", "accounts.json"))
    shutil.copy2(os.path.join(kit, ".setup-state"), os.path.join(new, ".setup-state"))
    code, out, said = run_wizard(new, state, person(home, keep=True), bash)
    yield "update from a new ZIP", out
    check(code == 0, f"update exit {code}")
    check(sum(":: wrangler secret put" in l for l in wrangler_calls(state)) == puts_before, "the update replaced a secret")
    for key in ("database_id", "id", "LEDGER_READER"):
        check(toml_var(new, key) == toml_var(kit, key), f"the update did not restore {key} in wrangler.toml")
    finished_install(new, state, out, "https://ledger.example.workers.dev", home)


def scenario_subdomain_later_zh(root, bash):
    """A brand-new account whose owner says 'no' to wrangler's subdomain question, registers one in the
    dashboard, and runs the wizard again. Traditional Chinese, Taiwan dollars, locked statements."""
    home = ("TWD", "Asia/Taipei", "TW", "zh-Hant")
    kit, state = make_kit(root, MEI_ACCOUNTS), os.path.join(root, "cloudflare")
    code, out, said = run_wizard(kit, state, person(home, subdomain="n", owner_email="mei@example.invalid"), bash)
    yield "first run (says no to the subdomain)", out
    check(code != 0, "the wizard carried on without a workers.dev subdomain")
    tail = out[-1500:]
    check("workers.dev subdomain" in tail and "Workers & Pages" in tail and "bash scripts/setup.sh" in tail,
          "the stop at stage 9 does not say how to get a subdomain and to run the wizard again")
    check(not re.search(r"\n\s+at .+\(.*:\d+:\d+\)", out), "a stack trace reached the screen")

    code, out, said = run_wizard(kit, state, person(home, owner_email="mei@example.invalid", pdf_locked="y"), bash,
                                 {"FAKE_SUBDOMAIN_REGISTERED": "test"})
    yield "second run (subdomain registered)", out
    check(code == 0, f"second run exit {code}")
    finished_install(kit, state, out, "https://ledger.test.workers.dev", home, "mei@example.invalid")
    check("LEDGER_PDF_PW_FORMOSA" in fake(state)["secrets"], "the locked bank's PDF password was not set")
    check("「連接 Gmail」" in out.split("Setup complete", 1)[1], "the Chinese closing screen does not name 「連接 Gmail」")
    cats = toml_var(kit, "LEDGER_CATEGORIES")
    check(cats.startswith("餐飲") and "其他" in cats, f"a zh-Hant install did not start with the Chinese categories (got {cats!r})")


SCENARIOS = {"new-account-en": scenario_new_account_en, "subdomain-later-zh": scenario_subdomain_later_zh}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--bash", default="bash", help="the bash to run the wizard with (e.g. a bash 3.2 build)")
    ap.add_argument("--keep", action="store_true", help="keep the temporary folders and transcripts")
    ap.add_argument("--only", choices=sorted(SCENARIOS))
    args = ap.parse_args()
    version = subprocess.run([args.bash, "-c", "echo $BASH_VERSION"], capture_output=True, text=True).stdout.strip()
    print(f"setup.sh rehearsal under bash {version}")
    failed = 0
    for name, scenario in SCENARIOS.items():
        if args.only and name != args.only:
            continue
        root = tempfile.mkdtemp(prefix=f"ledger-rehearse-{name}-")
        step, out = "start", ""
        try:
            for step, out in scenario(root, args.bash):
                with open(os.path.join(root, f"{step.split(' ')[0]}-{len(os.listdir(root))}.txt"), "w", encoding="utf8") as fh:
                    fh.write(out)
            print(f"  ✓ {name}")
        except Failed as e:
            failed += 1
            print(f"  ✗ {name} — {step}: {e}\n    transcripts in {root}\n    last screen:\n" +
                  "\n".join("      " + l for l in out[-1200:].splitlines()))
            args.keep = True
        finally:
            if not args.keep:
                shutil.rmtree(root, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
