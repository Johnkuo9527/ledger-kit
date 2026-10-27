#!/usr/bin/env bash
#
# Fails if the repository is about to publish personal data: your own email,
# card numbers, keys, your Cloudflare address or ids, or anything on a private
# denylist you keep OUTSIDE the repository.
#
#   bash scripts/check-no-personal-data.sh                       built-in checks only
#   bash scripts/check-no-personal-data.sh --denylist ~/my-words.txt
#   PERSONAL_DENYLIST=~/my-words.txt npm run check:personal-data
#
# The denylist is one extended regular expression per line, matched without
# regard to case; blank lines and lines starting with # are skipped. Put your
# name, card last-4s, the names of people you pay, your shops… in it — and never
# commit it.
#
# It scans the files git would publish: tracked files plus new files that are
# not ignored. seed/accounts.json (your real accounts) is ignored on purpose.
# Exit 0 = clean, 1 = something leaked, 2 = usage error.

set -euo pipefail

cd "$(dirname "$0")/.."

denylist="${PERSONAL_DENYLIST:-}"
while (( $# )); do
	case "$1" in
		--denylist) denylist="${2:-}"; shift 2 ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done
if [[ -n "$denylist" && ! -r "$denylist" ]]; then
	echo "cannot read the denylist: $denylist" >&2
	exit 2
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	mapfile -t files < <(git ls-files -co --exclude-standard)
else
	mapfile -t files < <(find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -not -path './worker/generated/*' | sed 's#^\./##')
fi
# Binary files, lockfiles and this script (it spells the patterns out) are skipped.
scan=()
for f in "${files[@]}"; do
	[[ -f "$f" ]] || continue
	case "$f" in
		*package-lock.json|*.pdf|*.png|*.jpg|*.jpeg|*.gif|*.ico|scripts/check-no-personal-data.sh) continue ;;
	esac
	scan+=("$f")
done

failed=0
report() { # report "what" <grep output>
	local what="$1" out="$2"
	[[ -z "$out" ]] && return 0
	failed=1
	printf '\n✗ %s\n' "$what"
	printf '%s\n' "$out" | cut -c1-200 | head -n 20
}
search() { # search <grep -E args...>: matches across the scanned files, file:line:text
	(( ${#scan[@]} )) || return 0
	grep -nIE "$@" -- "${scan[@]}" 2>/dev/null || true
}

# 1. Your real accounts are never committed.
for f in seed/accounts.json seed/accounts.sql; do
	if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
		report "your own accounts file is tracked by git" "$f (remove it with: git rm --cached $f)"
	fi
done

# 2. wrangler.toml keeps its placeholders when the kit itself is published.
if [[ "${ALLOW_FILLED_WRANGLER:-}" != "1" ]]; then
	report "wrangler.toml carries a real database or KV id (set ALLOW_FILLED_WRANGLER=1 in your own private copy)" \
		"$(grep -nE '^(database_id|id) = ' wrangler.toml | grep -v 'REPLACE-WITH-YOUR' || true)"
fi

# 3. A workers.dev address other than the placeholders.
report "a real workers.dev address" \
	"$(search -i '[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' | grep -viE '(ledger\.)?(test|your-subdomain|yourname|xxxx|example)\.workers\.dev|\*\.workers\.dev|<[^>]*>\.workers\.dev' || true)"

# 4. A personal mailbox address (public providers; the tests' x@gmail.com is a made-up sample).
report "a personal email address" \
	"$(search -io '[a-z0-9._%+-]+@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|qq|163)\.[a-z.]+' | grep -viE ':x@gmail\.com$' || true)"

# 5. A full card number (16 digits); 4000 0000 0000 xxxx is the made-up test card.
report "a full card number" \
	"$(search '\b[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\b' | grep -vE '4000[ -]?0000[ -]?0000' || true)"

# 6. Keys and secrets by their known shapes.
report "an API key or OAuth secret" \
	"$(search 'sk-ant-[A-Za-z0-9_-]{10,}|\bre_[A-Za-z0-9]{16,}|GOCSPX-[A-Za-z0-9_-]{10,}|[0-9]{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com|-----BEGIN [A-Z ]*PRIVATE KEY-----' || true)"

# 7. Your private denylist.
if [[ -n "$denylist" ]]; then
	while IFS= read -r pattern || [[ -n "$pattern" ]]; do
		[[ -z "${pattern//[[:space:]]/}" || "$pattern" =~ ^[[:space:]]*# ]] && continue
		report "denylist: $pattern" "$(search -i -e "$pattern" || true)"
	done < "$denylist"
fi

if (( failed )); then
	printf '\nPersonal data check: FAILED. Remove what is listed above before publishing.\n'
	exit 1
fi
printf 'Personal data check: OK (%s files scanned%s).\n' "${#scan[@]}" "${denylist:+, with your denylist}"
