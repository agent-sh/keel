#!/bin/sh
# A stand-in terminal for the move to another harness (src/integrations/terminal-open.ts): it opens no window.
# Usage, as the terminal command: sh terminal-standin.sh LOG. It writes the folder it was started in and each
# word it was given, one a line, to LOG, then ends with status 0 as a terminal that hands its window off does.
log="$1"; shift
{ echo "cwd $PWD"; for a in "$@"; do echo "arg $a"; done; echo "end"; } >> "$log"
