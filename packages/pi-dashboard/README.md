# @amaster.ai/pi-dashboard

Standalone manifest-driven dashboard runtime used by Pi Agent through an iframe.

```sh
pnpm --dir packages/pi-dashboard build
pi-dashboard serve --workspace ./dashboard --port 4207
```

The runtime reads `dashboard.json` from the workspace and serves a browser UI with visual layout editing.
