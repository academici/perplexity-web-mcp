#!/bin/bash
# Auto-detect XAUTHORITY for Mutter/XWayland (changes each session)
if [ -z "$XAUTHORITY" ]; then
  XAUTH_FILE=$(ls /run/user/$(id -u)/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
  if [ -n "$XAUTH_FILE" ]; then
    export XAUTHORITY="$XAUTH_FILE"
  fi
fi
export DISPLAY="${DISPLAY:-:0}"
exec node "$(dirname "$0")/dist/index.js" "$@"
