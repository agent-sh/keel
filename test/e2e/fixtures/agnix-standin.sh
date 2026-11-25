#!/bin/sh
# A stand-in for agnix (src/integrations/agnix.ts) for the scripted daemon (scripts/smoke.sh sets KEEL_AGNIX to it):
# called as agnix is, `--format json PATH...` in the folder it lints, it prints agnix's JSON with one error for a
# CLAUDE.md that imports a file whose name starts with "missing", as agnix's CC-MEM-001 does, and nothing else.
shift 2
n=0
diags=""
if [ -f CLAUDE.md ]; then
  line=$(grep -n '@missing' CLAUDE.md | head -n 1 | cut -d: -f1)
  if [ -n "$line" ]; then
    n=1
    diags="{\"level\":\"error\",\"rule\":\"CC-MEM-001\",\"file\":\"CLAUDE.md\",\"line\":$line,\"column\":1,\"message\":\"Import target not found\"}"
  fi
fi
printf '{"version":"stand-in","files_checked":%s,"diagnostics":[%s],"summary":{"errors":%s,"warnings":0,"info":0}}\n' "$#" "$diags" "$n"
[ "$n" = 0 ]
