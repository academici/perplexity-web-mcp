#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-detect XAUTHORITY for Mutter/XWayland (changes each session)
if [ -z "$XAUTHORITY" ]; then
  XAUTH_FILE=$(ls /run/user/$(id -u)/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
  if [ -n "$XAUTH_FILE" ]; then
    export XAUTHORITY="$XAUTH_FILE"
  fi
fi
export DISPLAY="${DISPLAY:-:0}"

# Resilient Chromium resolution. Playwright pins one browser revision in
# node_modules; if the ms-playwright cache has since been bumped to a newer
# revision (the pinned one pruned), launchPersistentContext fails with
# "Executable doesn't exist at .../chromium-<rev>/...". When no explicit path is
# set and Playwright's own pinned binary is missing, fall back to the newest
# installed ms-playwright Chromium so the daemon keeps working across cache
# bumps. A correctly-present pinned browser is left untouched.
if [ -z "$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH" ]; then
  pinned="$(cd "$SCRIPT_DIR" && node -e 'try{process.stdout.write(require("playwright-core").chromium.executablePath())}catch{}' 2>/dev/null)"
  if [ -z "$pinned" ] || [ ! -x "$pinned" ]; then
    PW_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
    fallback="$(ls -dt "$PW_CACHE"/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)"
    if [ -n "$fallback" ] && [ -x "$fallback" ]; then
      export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$fallback"
    fi
  fi
fi

exec node "$SCRIPT_DIR/dist/index.js" "$@"
