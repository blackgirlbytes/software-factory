#!/bin/sh
# Sprite exec sessions inherit capabilities that Bubblewrap refuses to accept.
# Drop them for Codex and its children; retain Codex's per-role sandbox policy.
set -eu
runtime="$HOME/.local/share/codextown-runtime/node_modules/.bin/codex"
if [ ! -x "$runtime" ]; then
  echo "Install @openai/codex@0.151.0 in ~/.local/share/codextown-runtime first." >&2
  exit 1
fi
exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$runtime" "$@"
