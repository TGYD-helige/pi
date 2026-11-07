#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"
: "${PI_INTEGRATION_BASE_URL:?PI_INTEGRATION_BASE_URL is required}"
: "${PI_INTEGRATION_API_KEY:?PI_INTEGRATION_API_KEY is required}"
: "${BASE_REF:?BASE_REF is required}"
: "${TRIALS:?TRIALS is required}"
: "${TASKS:?TASKS is required}"

case "${TARGET:-}" in
  browser) script=eval:browser ;;
  memory) script=eval:memory:product ;;
  *) echo 'TARGET must be browser or memory' >&2; exit 1 ;;
esac

cd "$GITHUB_WORKSPACE"
if [ "$TARGET" = browser ]; then
  pnpm --filter @amaster.ai/pi-browser-use build
fi

baseline="$RUNNER_TEMP/pi-eval-base"
git fetch --no-tags -- origin "$BASE_REF"
git worktree add --detach "$baseline" FETCH_HEAD
(
  cd "$baseline"
  pnpm install --frozen-lockfile
  pnpm build
  if [ "$TARGET" = browser ]; then pnpm --filter @amaster.ai/pi-browser-use build; fi
)

if [ "$TARGET" = browser ]; then
  npx -y @puppeteer/browsers install chrome@stable --path "$RUNNER_TEMP/chrome-install"
  CHROME_BIN=$(find "$RUNNER_TEMP/chrome-install" -name chrome -type f | head -1)
  test -n "$CHROME_BIN"
  export CHROME_BIN
fi

pnpm --filter @amaster.ai/pi-eval "$script" -- \
  --package-root "$baseline" --trials "$TRIALS" --tasks "$TASKS" \
  --output "$GITHUB_WORKSPACE/tests/eval/results/base.json"
pnpm --filter @amaster.ai/pi-eval "$script" -- \
  --trials "$TRIALS" --tasks "$TASKS" \
  --output "$GITHUB_WORKSPACE/tests/eval/results/head.json"
pnpm --filter @amaster.ai/pi-eval compare -- \
  results/base.json results/head.json results/comparison.md
cat tests/eval/results/comparison.md >> "$GITHUB_STEP_SUMMARY"

if [ "$TARGET" = memory ]; then
  pnpm --filter @amaster.ai/pi-eval eval:memory:product -- \
    --without-memory --trials "$TRIALS" --tasks "$TASKS" \
    --output "$GITHUB_WORKSPACE/tests/eval/results/control.json"
  pnpm --filter @amaster.ai/pi-eval compare -- \
    results/control.json results/head.json results/memory-benefit.md
  cat tests/eval/results/memory-benefit.md >> "$GITHUB_STEP_SUMMARY"
fi
