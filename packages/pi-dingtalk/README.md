# @amaster.ai/pi-dingtalk

![pi-dingtalk preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-dingtalk/preview.png)

Pi extension for [DingTalk](https://www.dingtalk.com/) workspace — calendar, docs, chat, todo, sheets, mail and more via [dws (DingTalk Workspace CLI)](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli).

## Features

- Auto-installs `dws` CLI if not present
- Initializes credentials from pi settings (non-interactive, via `--client-id` / `--client-secret`)
- Injects dws skills into the agent session (19 product skills)

## Configuration

Add to `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json`:

Project settings are loaded only after project trust is accepted. For environment-backed credentials, use user or agent settings because project settings do not expand `${ENV_VAR}`.

```json
{
  "pi-dingtalk": {
    "clientId": "your_client_id",
    "clientSecret": "your_client_secret"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `clientId` | Yes | App Key from [DingTalk Open Platform](https://open.dingtalk.com/) |
| `clientSecret` | Yes | App Secret |

## Skills Provided

19 skills from dws covering:

- `dingtalk-calendar` — Events, meeting rooms, free/busy
- `dingtalk-chat` — Messages, groups, bots, reactions
- `dingtalk-doc` — Document create, read, write
- `dingtalk-sheet` — Spreadsheet CRUD
- `dingtalk-aitable` — Bases, tables, records, fields
- `dingtalk-todo` — Task CRUD with priority/due date
- `dingtalk-contact` — User search, department tree
- `dingtalk-mail` — Email search, send, read
- `dingtalk-wiki` — Knowledge base management
- `dingtalk-meeting` / `dingtalk-minutes` — Meeting records, transcription
- `dingtalk-oa` — Approval workflows
- `dingtalk-schedule` — Schedule management
- `dingtalk-drive` — File operations
- And more...

## CLI Reference

- Repository: https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli
- Install: `npm install -g dingtalk-workspace-cli`
- Docs: https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli#readme
