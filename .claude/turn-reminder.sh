#!/bin/sh
# Carrick: adds one line to the first prompt of each Claude Code session.
# Needs jq. Prints nothing on any error.
payload=$(cat 2>/dev/null) || exit 0
sid=$(printf %s "$payload" | jq -r '.session_id // ""' 2>/dev/null) || exit 0
[ -n "$sid" ] || exit 0
marker="${TMPDIR:-/tmp}/carrick-turn-reminded-$sid"
[ -e "$marker" ] && exit 0
touch "$marker" 2>/dev/null || exit 0
printf %s 'Prefer one inline mcp__carrick__search_by_intent call over a grep sweep or a search subagent: describe the behaviour in plain English and it answers in one call, covering every repo in this project rather than only this one.'
exit 0
