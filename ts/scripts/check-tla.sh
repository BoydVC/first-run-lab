#!/usr/bin/env bash
# Model-check the session statechart. The mutant drops crashed→reported and must fail I1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAR="${ROOT}/.cache/tla2tools.jar"
mkdir -p "${ROOT}/.cache"
if [[ ! -f "$JAR" ]]; then
  curl -fsSL -o "$JAR" -L "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
fi
cd "${ROOT}/tla"
java -cp "$JAR" tlc2.TLC -workers 1 -config Session.cfg Session.tla
set +e
OUT="$(java -cp "$JAR" tlc2.TLC -workers 1 -config SessionMutant.cfg Session.tla 2>&1)"
CODE=$?
set -e
if [[ "$CODE" -eq 0 ]]; then
  echo "mutant should have failed I1" >&2
  exit 1
fi
printf '%s\n' "$OUT" | grep -E 'I1|Temporal properties were violated|Error:' >/dev/null
echo "mutant failed as expected"
