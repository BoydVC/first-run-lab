#!/usr/bin/env bash
# Model-check spec/FirstRunLab.tla. The correct model must pass.
# Each mutant must be rejected; a survivor fails CI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
JAR="${TLA_JAR:-$ROOT/tools/tla2tools.jar}"
if [[ ! -f "$JAR" ]]; then
  mkdir -p "$ROOT/tools"
  curl -fsSL -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
fi
mkdir -p "$ROOT/spec/tlc"
run() {
  local name="$1" cfg="$2"
  local out="$ROOT/spec/tlc/${name}.out"
  local meta="$ROOT/spec/tlc/${name}-states"
  rm -rf "$meta"
  set +e
  java -Xmx2g -XX:+UseParallelGC -jar "$JAR" -config "$cfg" -workers 1 \
    -cleanup -nowarning -metadir "$meta" spec/FirstRunLab.tla >"$out" 2>&1
  local code=$?
  set -e
  rm -rf "$meta"
  echo "$code"
}
code="$(run none spec/FirstRunLab.cfg)"
if [[ "$code" != "0" ]] || ! grep -q "No error has been found" spec/tlc/none.out; then
  echo "TLC: correct model failed (exit $code)" >&2
  tail -40 spec/tlc/none.out >&2
  exit 1
fi
echo "TLC: correct model OK"
fail=0
for m in drop_crashed_report score_while_crashed merge_drops; do
  code="$(run "$m" "spec/mutants/${m}.cfg")"
  if [[ "$code" == "0" ]] && grep -q "No error has been found" "spec/tlc/${m}.out"; then
    echo "MUTANT SURVIVED: $m" >&2
    fail=1
  else
    echo "TLC: killed $m (exit $code)"
  fi
done
exit "$fail"
