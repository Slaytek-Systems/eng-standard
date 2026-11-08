#!/usr/bin/env bash
# covers: bin/eng.mjs
# The global CLI is the hallway (Matt, 6 Nov 2026): --help lists exactly these commands, and gate is one of them.
set -euo pipefail
got=$(node bin/eng.mjs --help | sed -n 's/^  eng \([a-z0-9]*\).*/\1/p' | tr '\n' ' ')
want='init sync lint run verdict e2e rules gate merge doctor '
[ "$got" = "$want" ] || { echo "eng --help lists: $got; want: $want"; exit 1; }
echo "eng --help lists the hallway: $got"
