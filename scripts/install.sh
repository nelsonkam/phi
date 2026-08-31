#!/bin/sh
# Installs the phi binary for this platform from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/nelsonkam/phi/main/scripts/install.sh | sh
#
# A public repository is read anonymously. A private source needs the authenticated
# `gh` CLI (`gh auth login`). Unlike `phi update`, this installer does not send
# GITHUB_TOKEN.
#
# Environment:
#   PHI_INSTALL_DIR   where to put the binary (default ~/.local/bin)
#   PHI_UPDATE_REPO   owner/name to install from (default nelsonkam/phi)
#   PHI_VERSION       release tag to pin, e.g. v0.1.0 (default: the latest release)

set -eu

REPO="${PHI_UPDATE_REPO:-nelsonkam/phi}"
INSTALL_DIR="${PHI_INSTALL_DIR:-$HOME/.local/bin}"
TAG="${PHI_VERSION:-}"
tmp=

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "$tmp" ]; then
    rm -rf "$tmp"
  fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_gh() {
  command -v gh >/dev/null 2>&1 || die "$REPO is not readable anonymously -- it is private, or it has no releases.
       Install the GitHub CLI (https://cli.github.com) and run \`gh auth login\` to install from it,
       or set PHI_UPDATE_REPO if binaries are published elsewhere."
}

# Anonymous first so a public install needs no GitHub account at all; any refusal retries through gh.
github_api() {
  if body=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/$1" 2>/dev/null); then
    printf '%s' "$body"
    return 0
  fi
  require_gh
  gh api "$1" 2>/dev/null || die "gh could not read $1 from $REPO.
       Run \`gh auth login\` with an account that has access, or check \`gh auth status\`."
}

json_field() {
  # Field values in a release payload are plain strings; splitting on commas keeps this to one sed.
  tr ',' '\n' | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"
}

command -v curl >/dev/null 2>&1 || die "curl is required."

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) die "No release binary is published for $(uname -s)." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "No release binary is published for $(uname -m)." ;;
esac
asset="phi-${platform}-${arch}"

if [ -n "$TAG" ]; then
  release=$(github_api "repos/$REPO/releases/tags/$TAG")
else
  release=$(github_api "repos/$REPO/releases/latest")
  TAG=$(printf '%s' "$release" | json_field tag_name | head -1)
  [ -n "$TAG" ] || die "Could not read a release tag from $REPO."
fi

# Refuse early with the assets that do exist: a release may ship only one architecture.
available=$(printf '%s' "$release" | json_field name | grep '^phi-' || true)
printf '%s\n' "$available" | grep -qx "$asset" || die "Release $TAG has no asset named $asset.
       Published for this release: $(printf '%s' "$available" | tr '\n' ' ')
       See https://github.com/$REPO/releases/tag/$TAG"

dest="$INSTALL_DIR/phi"
mkdir -p "$INSTALL_DIR"
if [ -d "$dest" ]; then
  die "$dest is a directory; refuse to replace it. Set PHI_INSTALL_DIR to a different location."
fi

printf 'Installing phi %s (%s) to %s\n' "$TAG" "$asset" "$INSTALL_DIR"

tmp=$(mktemp -d "$INSTALL_DIR/.phi-install.XXXXXX")
staged="$tmp/phi"

if ! curl -fsSL -o "$staged" "https://github.com/$REPO/releases/download/$TAG/$asset" 2>/dev/null; then
  require_gh
  gh release download "$TAG" --repo "$REPO" --pattern "$asset" --output "$staged" --clobber \
    || die "Could not download $asset from $TAG."
fi
[ -s "$staged" ] || die "Downloaded $asset is empty."

chmod 755 "$staged"
# Sibling of dest, so this is a same-filesystem rename and leaves the old binary until it succeeds.
mv -f "$staged" "$dest" || die "Could not write $dest. Set PHI_INSTALL_DIR to a writable directory."

printf 'Installed %s\n' "$dest"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) printf '\n%s is not on your PATH. Add it:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" ;;
esac

printf '\nNext: phi serve\nOr run in the background: phi service install\n'
