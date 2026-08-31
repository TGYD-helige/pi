# @amaster.ai/pi-wecom

![pi-wecom preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-wecom/preview.png)

Pi extension for [WeCom (企业微信)](https://work.weixin.qq.com/) workspace — contacts, messages, meetings, schedules, docs and more via [wecom-cli](https://github.com/WecomTeam/wecom-cli).

## Features

- Auto-installs `wecom-cli` if not present
- Injects wecom-cli skills into the agent session
- Detects authentication status and prompts for QR code login if needed

## Configuration

Add to `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json`:

Project settings are loaded only after project trust is accepted. For environment-backed credentials, use user or agent settings because project settings do not expand `${ENV_VAR}`.

```json
{
  "pi-wecom": {
    "botId": "your_bot_id",
    "botSecret": "your_bot_secret"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `botId` | Yes | Bot ID from [WeCom Admin Console](https://work.weixin.qq.com/) |
| `botSecret` | Yes | Bot Secret |

> **Note:** wecom-cli requires QR code scan for initial authentication. After the extension installs the CLI, run `wecom-cli auth init --noninteractive` to complete login.

## Skills Provided

14 skills from wecom-cli covering:

- `wecomcli-shared` — Shared setup and authentication checks
- `wecomcli-message` — Messages and conversations
- `wecomcli-contact` — Address book, user search
- `wecomcli-meeting` — Create, cancel, manage meetings
- `wecomcli-calendar` — Schedule CRUD, free/busy
- `wecomcli-todo` — Task management
- `wecomcli-email` — Email search and reading
- `wecomcli-disk` — WeDrive files and folders
- `wecomcli-media` — Media upload and download
- `wecomcli-doc-manage` — Document search and permissions
- `wecomcli-doc` — Online documents
- `wecomcli-sheet` — Online spreadsheets
- `wecomcli-smartsheet` — Smart Sheet data and structure
- `wecomcli-smartpage` — Smart documents

## CLI Reference

- Repository: https://github.com/WecomTeam/wecom-cli
- Install: `npm install -g @wecom/cli`
- Docs: https://github.com/WecomTeam/wecom-cli#readme
