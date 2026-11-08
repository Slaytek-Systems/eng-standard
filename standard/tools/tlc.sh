#!/usr/bin/env bash
# Suggested bounded TLC run (eng-standard standard/tools/tlc.sh): a suggestion, not a gate. Copy it into the repo's
# scripts/ and call it from a heavy check, for example .eng/checks/model.sh:
#   # weight: heavy
#   # budget: memory=1G workers=1 timeout=180s
#   scripts/tlc.sh specs/Flow.tla specs/Flow.cfg
# Bounds: heap -Xmx768m, -workers 1, timeout 120s. Under eng (gate or eng run --) the check's budget sets them instead
# (ENG_BUDGET_HEAP_MB, ENG_BUDGET_WORKERS, ENG_BUDGET_TIMEOUT_S). The jar is pinned and checksummed, fetched once into
# the shared download cache (ENG_DOWNLOAD_CACHE), and never run when its SHA-256 does not match.
# usage: tlc.sh <Spec.tla> [<Spec.cfg>] [extra TLC args...]
set -euo pipefail
TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v${TLA_VERSION}/tla2tools.jar"
heap=${ENG_BUDGET_HEAP_MB:-768} workers=${ENG_BUDGET_WORKERS:-1} secs=${ENG_BUDGET_TIMEOUT_S:-120}
[ $# -ge 1 ] || { echo "usage: $0 <Spec.tla> [<Spec.cfg>] [TLC args...]" >&2; exit 2; }
spec=$1; shift
cfg=(); if [ $# -ge 1 ] && [[ $1 == *.cfg ]]; then cfg=(-config "$1"); shift; fi
cache=${ENG_DOWNLOAD_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/eng/downloads}
jar="$cache/tla2tools-$TLA_VERSION.jar"
sum() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
if [ ! -f "$jar" ]; then
  mkdir -p "$cache"
  part="$jar.part.$$"
  curl -fsSL --retry 2 -o "$part" "$TLA_URL" || { rm -f "$part"; echo "tlc.sh: download of $TLA_URL failed" >&2; exit 1; }
  mv "$part" "$jar"
fi
got=$(sum "$jar")
[ "$got" = "$TLA_SHA256" ] || { echo "tlc.sh: $jar has SHA-256 $got, want $TLA_SHA256 (tla2tools $TLA_VERSION); not running it" >&2; exit 1; }
meta=$(mktemp -d -p "${ENG_TMP:-${TMPDIR:-/tmp}}" tlc-meta.XXXXXX)
trap 'rm -rf "$meta"' EXIT
limit=(); if command -v timeout >/dev/null; then limit=(timeout --kill-after=10 "$secs"); fi
${limit[@]+"${limit[@]}"} java -Xmx"${heap}m" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers "$workers" -metadir "$meta" -cleanup ${cfg[@]+"${cfg[@]}"} "$@" "$spec"
