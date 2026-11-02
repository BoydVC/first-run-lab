#!/usr/bin/env bash
# Run TLC on the generated session model. Downloads tla2tools.jar on first use.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .tools spec
JAR=".tools/tla2tools.jar"
if [[ ! -f "$JAR" ]]; then
  curl -fsSL -o "$JAR" "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar" \
    || curl -fsSL -o "$JAR" "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
fi
npx --yes tsx src/tla-cli.ts
cd spec
java -XX:+UseParallelGC -cp "../$JAR" tlc2.TLC -workers 2 -config MC.cfg Session.tla
