#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = hierarchy ]; then
  export PI_SUBAGENT_CHILD_AGENT=ci-hierarchy
  prompt='Use the bash tool exactly once to run: bash .github/scripts/telemetry-subagent.sh. Then reply with the single word HIERARCHY-CHILD-READY.'
else
  export PI_SUBAGENT_CHILD_AGENT=ci-probe
  prompt="Use the bash tool exactly once to run: echo ${TELEMETRY_CODEWORD:-ci-langfuse-probe} child. Then reply with the single word SUBAGENT-READY."
fi

exec pi \
  --provider deepseek-integration \
  --model "${PI_INTEGRATION_MODEL:-deepseek-v4-flash}" \
  --thinking minimal \
  --no-session \
  --no-context-files \
  --tools bash \
  --mode text \
  -p "$prompt"
