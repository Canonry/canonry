#!/bin/sh
# Carrick: on the first search of a Claude Code session, adds one line of
# context about the Carrick index. It never blocks or approves a tool call.
# Needs jq and awk. Without them, or with a payload it cannot read, it prints
# nothing.
payload=$(cat 2>/dev/null) || exit 0
tool=$(printf %s "$payload" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
case "$tool" in
  Grep) ;;
  Bash)
    cmd=$(printf %s "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
    # Reads the command each shell segment runs, ignoring quoted text and heredocs.
    hit=$(printf %s "$cmd" | awk -v sq="'" -v dq='"' -v seps='[|&;(){}`]+' '
      BEGIN {
        split("grep egrep fgrep rg ag ack find fd", s, " ")
        for (k in s) SEARCH[s[k]] = 1
        split("sudo time command nohup xargs if then else elif do while until for !", w, " ")
        for (k in w) SKIP[w[k]] = 1
      }
      function scan(text,   nseg, segs, k, nw, word, i, cmd, m) {
        nseg = split(text, segs, seps)
        for (k = 1; k <= nseg; k++) {
          nw = split(segs[k], word, " ")
          i = 1
          while (i <= nw && (word[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/ || (word[i] in SKIP))) i++
          if (i > nw) continue
          cmd = word[i]
          sub(/^.*\//, "", cmd)
          if (cmd == "git") {
            for (m = i + 1; m <= nw && m <= i + 3; m++) if (word[m] == "grep") hit = 1
            continue
          }
          if (cmd in SEARCH) hit = 1
        }
      }
      {
        if (hd != "") {
          line = $0
          if (hdstrip) sub(/^[ \t]+/, "", line)
          if (line == hd) hd = ""
          next
        }
        line = $0
        out = ""
        i = 1
        n = length(line)
        while (i <= n) {
          c = substr(line, i, 1)
          if (insq) { if (c == sq) insq = 0; i++; continue }
          if (indq) {
            if (c == "\\") { i += 2; continue }
            if (c == dq) indq = 0
            i++
            continue
          }
          if (c == "\\") { i += 2; out = out "Q"; continue }
          if (c == sq) { insq = 1; out = out "Q"; i++; continue }
          if (c == dq) { indq = 1; out = out "Q"; i++; continue }
          if (c == "<" && substr(line, i + 1, 1) == "<") {
            j = i + 2
            if (substr(line, j, 1) == "<") { i = j + 1; out = out " "; continue }
            hdstrip = 0
            if (substr(line, j, 1) == "-") { hdstrip = 1; j++ }
            while (substr(line, j, 1) == " ") j++
            d = ""
            while (j <= n) {
              ch = substr(line, j, 1)
              if (ch == " " || ch == ";" || ch == "|" || ch == "&" || ch == "<" || ch == ">") break
              if (ch != sq && ch != dq && ch != "\\") d = d ch
              j++
            }
            pend = d
            i = j
            out = out " "
            continue
          }
          out = out c
          i++
        }
        scan(out)
        if (pend != "") { hd = pend; pend = "" }
      }
      END { if (hit) print "search" }
    ' 2>/dev/null) || exit 0
    [ -n "$hit" ] || exit 0
    ;;
  *) exit 0 ;;
esac
# Silent once this session has called a Carrick tool.
tp=$(printf %s "$payload" | jq -r '.transcript_path // ""' 2>/dev/null)
if [ -n "$tp" ] && [ -r "$tp" ] && grep -q '"name":"mcp__carrick__' "$tp" 2>/dev/null; then
  exit 0
fi
sid=$(printf %s "$payload" | jq -r '.session_id // ""' 2>/dev/null) || exit 0
[ -n "$sid" ] || exit 0
marker="${TMPDIR:-/tmp}/carrick-search-nudged-$sid"
[ -e "$marker" ] && exit 0
touch "$marker" 2>/dev/null || exit 0
jq -cn --arg t 'Carrick has an index of this workspace. For a helper, an endpoint, a consumer or a type that lives elsewhere, `search_by_intent` and the other Carrick tools answer what grep cannot; grep to confirm a location.' '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$t}}' 2>/dev/null || exit 0
exit 0
