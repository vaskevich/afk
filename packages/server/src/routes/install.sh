#!/bin/sh
# afk installer. An afk server serves this at <origin>/install and fills in AFK_ORIGIN
# below, so the client it installs talks to that same server:
#
#   curl -fsSL https://afk.osv.im/install | sh
#
# Downloads the client (one bash script) from <origin>/cli/afk into ~/.local/bin, or
# $AFK_INSTALL_DIR if set, after checking it against <origin>/cli/afk.sha256. Nothing
# else is touched: no sudo, no shell profile edits.
set -eu

AFK_ORIGIN="__AFK_ORIGIN__"
AFK_INSTALL_DIR="${AFK_INSTALL_DIR:-$HOME/.local/bin}"
AFK_BIN="$AFK_INSTALL_DIR/afk"
# Marks the line in the client that sets its default server; the installer rewrites it.
MARKER="# afk-install: default server"

# The client's collectors use macOS tools (ps, sysctl, vm_stat); Linux is on the backlog.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "afk: error: only macOS is supported right now (TODO: linux)" >&2
  exit 1
fi
command -v curl >/dev/null || { echo "afk: error: curl is required" >&2; exit 1; }

# Over https, refuse a downgrade to any other scheme (a redirect to http, say) and to
# TLS below 1.2. Plain http stays allowed as is: a self-hosted server on a private
# network is often reached that way, and the checksum below still catches corruption.
fetch() { # url destination
  case "$AFK_ORIGIN" in
    https://*) curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2" ;;
    *) curl -fsSL "$1" -o "$2" ;;
  esac
}

# shasum ships with macOS; sha256sum is the coreutils spelling, for when it is there
# instead. Picked before anything is downloaded so a machine with neither stops early.
if command -v shasum >/dev/null; then
  verify_checksum() { shasum -a 256 -c "$1"; }
elif command -v sha256sum >/dev/null; then
  verify_checksum() { sha256sum -c "$1"; }
else
  echo "afk: error: neither shasum nor sha256sum is available to verify the download" >&2
  exit 1
fi

# Everything is downloaded into a temporary directory and only moved into place once
# it checks out, so a failed or corrupted download never leaves a broken afk behind.
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
fetch "$AFK_ORIGIN/cli/afk" "$tmpdir/afk"
fetch "$AFK_ORIGIN/cli/afk.sha256" "$tmpdir/afk.sha256"

# The checksum file names the script "afk", the name it was downloaded under above.
# Same origin as the script, so this catches a corrupted transfer or a stale cached
# copy, not a server that serves both a tampered script and a matching checksum.
(cd "$tmpdir" && verify_checksum afk.sha256 >/dev/null 2>&1) || {
  echo "afk: error: the downloaded client does not match $AFK_ORIGIN/cli/afk.sha256; nothing was installed" >&2
  exit 1
}

# Point the client at the server it came from, so a self-hosted install needs no
# AFK_SERVER variable. The variable still wins when it is set.
sed "s|^AFK_SERVER=.*$MARKER\$|AFK_SERVER=\"\${AFK_SERVER:-$AFK_ORIGIN}\" $MARKER|" "$tmpdir/afk" > "$tmpdir/afk.installed"
chmod +x "$tmpdir/afk.installed"
grep -q "AFK_SERVER:-$AFK_ORIGIN" "$tmpdir/afk.installed" || {
  echo "afk: error: could not set the default server in the downloaded client; nothing was installed" >&2
  exit 1
}
mkdir -p "$AFK_INSTALL_DIR"
mv "$tmpdir/afk.installed" "$AFK_BIN"

echo "installed $("$AFK_BIN" version) to $AFK_BIN (server $AFK_ORIGIN)"

# Say how to get the directory on PATH when it is not, for the two shells macOS ships.
case ":$PATH:" in
  *":$AFK_INSTALL_DIR:"*) ;;
  *)
    echo
    echo "$AFK_INSTALL_DIR is not on your PATH. Add this line to ~/.zshrc (zsh, the macOS"
    echo "default) or ~/.bash_profile (bash), then open a new terminal:"
    echo "  export PATH=\"$AFK_INSTALL_DIR:\$PATH\""
    ;;
esac

echo
echo "Next:"
echo "  afk start               watch this machine from your phone"
echo "  afk run -- <command>    run a command and see whether it finished"
