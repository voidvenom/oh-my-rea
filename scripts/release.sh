#!/usr/bin/env bash
# Maintainer release: checks, npm publish (passkey approval in the browser), git tag, push.
# Run from anywhere:  scripts/release.sh
set -euo pipefail

cd "$(dirname "$0")/.."
REMOTE="${RELEASE_REMOTE:-public}"
BRANCH="main"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

say "Checking repository state"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || fail "not on $BRANCH"
[ -z "$(git status --porcelain)" ] || fail "working tree has uncommitted changes (commit or stash first)"
git fetch -q "$REMOTE" "$BRANCH"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$REMOTE/$BRANCH")" ] \
  || fail "local $BRANCH differs from $REMOTE/$BRANCH (git pull, or git push your commits first)"

NAME="$(node -p 'require("./package.json").name')"
VERSION="$(node -p 'require("./package.json").version')"
SRC_VERSION="$(sed -n 's/.*"\([0-9][0-9.]*\)".*/\1/p' src/version.ts)"
[ "$VERSION" = "$SRC_VERSION" ] || fail "version mismatch: package.json=$VERSION src/version.ts=$SRC_VERSION"
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && fail "tag v$VERSION already exists"
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then fail "$NAME@$VERSION is already on npm; bump the version first"; fi
npm whoami >/dev/null 2>&1 || fail "not logged in to npm (run: npm login)"

say "Typecheck and tests"
npm ci --silent
npm run -s typecheck
npm run -s build
node dist/main.js changelog "$VERSION" >/dev/null || fail "CHANGELOG.md needs a section for $VERSION"
node test/run.mjs >/dev/null || fail "tests failed (run npm test to see details)"

say "Ready to publish $NAME@$VERSION as $(npm whoami)"
read -r -p "Publish now? [y/N] " answer
[ "$answer" = "y" ] || [ "$answer" = "Y" ] || fail "cancelled, nothing was published"

say "Publishing to npm (approve with your passkey when the browser opens)"
npm publish --access public

say "Tagging v$VERSION and pushing"
git tag "v$VERSION"
git push "$REMOTE" "$BRANCH" "v$VERSION"

say "Done: $NAME@$VERSION is published. It can take a few minutes to appear on npm."
echo "  https://www.npmjs.com/package/$NAME"
