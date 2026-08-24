# @amaster.ai/pi-lark

![pi-lark preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-lark/preview.png)

Pi extension for [Lark/Feishu](https://www.feishu.cn/) workspace — calendar, docs, drive, sheets, tasks, mail and more via [lark-cli](https://github.com/larksuite/cli).

## Features

- Auto-installs `lark-cli` if not present
- Initializes credentials from pi settings (non-interactive)
- Injects lark-cli skills into the agent session (calendar, IM, docs, drive, sheets, tasks, mail, wiki, etc.)

## Configuration

Add to `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json`:

Project settings are loaded only after project trust is accepted. For environment-backed credentials, use user or agent settings because project settings do not expand `${ENV_VAR}`.

```json
{
  "pi-lark": {
    "appId": "cli_xxx",
    "appSecret": "your_app_secret",
    "domain": "feishu"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `appId` | Yes | App ID from [Feishu Open Platform](https://open.feishu.cn/) |
| `appSecret` | Yes | App Secret |
| `domain` | No | `"feishu"` (default) or `"lark"` (international) |

## Skills Provided

27 skills from lark-cli covering:

- `lark-calendar` — Events, agenda, free/busy, room booking
- `lark-im` — Messages, group chats, search
- `lark-doc` — Create, read, update documents
- `lark-drive` — Upload, download, manage files
- `lark-sheets` — Spreadsheet CRUD
- `lark-base` — Tables, records, views, dashboards
- `lark-task` — Tasks, subtasks, reminders
- `lark-mail` — Email send, read, search
- `lark-wiki` — Knowledge spaces and nodes
- `lark-contact` — User search, profiles
- And more...

## CLI Reference

- Repository: https://github.com/larksuite/cli
- Install: `npm install -g @larksuite/cli`
- Docs: https://github.com/larksuite/cli#readme
