#!/bin/sh
# afk installer. An afk server serves this at <origin>/install and fills in AFK_ORIGIN
# below, so the client it installs talks to that same server:
#
#   curl -fsSL https://afk.osv.im/install | sh
#
# Downloads the client (one bash script) from <origin>/cli/afk into ~/.local/bin, or
# $AFK_INSTALL_DIR if set. Nothing else is touched: no sudo, no shell profile edits.
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

# Download to a temporary file so a failed download never leaves a broken afk behind.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$AFK_ORIGIN/cli/afk" -o "$tmp"

# Point the client at the server it came from, so a self-hosted install needs no
# AFK_SERVER variable. The variable still wins when it is set.
mkdir -p "$AFK_INSTALL_DIR"
sed "s|^AFK_SERVER=.*$MARKER\$|AFK_SERVER=\"\${AFK_SERVER:-$AFK_ORIGIN}\" $MARKER|" "$tmp" > "$AFK_BIN"
chmod +x "$AFK_BIN"
grep -q "AFK_SERVER:-$AFK_ORIGIN" "$AFK_BIN" || {
  echo "afk: error: could not set the default server in $AFK_BIN" >&2
  exit 1
}

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
