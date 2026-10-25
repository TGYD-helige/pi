# @amaster.ai/pi-channels

![pi-channels preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-channels/preview.png)

Pi extension for native messaging channels.

This package follows the same extension shape as the open-source `@e9n/pi-channels` package: it registers a `notify` tool, channel events, route aliases, and an optional chat bridge that turns incoming channel messages into pi prompts.

It does not depend on `@e9n/pi-channels` at runtime. That package is published as a standalone extension source package with the older `@mariozechner/*` peer namespace and Slack/Telegram dependencies. This package keeps the same channel contract while targeting this repo's `@earendil-works/*` API surface and native Feishu/DingTalk/WeCom adapters.

## Configuration

Put the `pi-channels` section in `~/.pi/agent/settings.json`, the configured agent directory's `settings.json`, or a project/ancestor `.pi/settings.json`. Project-local files are read only after project trust is accepted. `${ENV_VAR}` interpolation is supported only in user and agent settings, not in project-local files. The direct credential environment variables documented in the examples still override loaded adapter values.

## Channels

- `feishu` - Native Feishu/Lark app messaging backed by the official `@larksuiteoapi/node-sdk`. Supports outgoing Markdown rich-text posts with plain-text fallback, WebSocket events by default, HTTP event callbacks as a fallback, and incoming text, post, and image messages. Both event modes download images from standalone image messages and rich-text posts to temporary files and pass them to the Pi bridge as image input. If an image download fails, text and successfully downloaded images are still delivered with a note asking the sender to resend missing images. Download failures and unsupported message types produce sanitized error diagnostics without requiring DEBUG; the Feishu app must be allowed to download message resources.
- `wecom` - Native WeCom intelligent bot messaging backed by the official
  `@wecom/aibot-node-sdk`. Supports WebSocket long connection events and active
  Markdown pushes with Bot ID / Secret credentials.
- `dingtalk` - Native DingTalk app bot messaging backed by the official
  `dingtalk-stream` SDK. Supports Stream mode incoming bot messages, reply
  messages through `sessionWebhook`, and active group text pushes through the
  DingTalk OpenAPI.
- `webhook` - Generic outgoing HTTP requests.

## Example

The `${...}` placeholders below assume this section is stored in user or agent settings. For trusted project settings, use the corresponding direct credential environment variables or literal non-secret values.

```json
{
  "pi-channels": {
    "adapters": {
      "feishu": {
        "type": "feishu",
        "appId": "${FEISHU_APP_ID}",
        "appSecret": "${FEISHU_APP_SECRET}",
        "eventMode": "websocket",
        "respondToMentionsOnly": true
      },
      "wecom": {
        "type": "wecom",
        "botId": "${WECOM_BOT_ID}",
        "secret": "${WECOM_BOT_SECRET}",
        "eventMode": "websocket",
        "respondToMentionsOnly": true,
        "timeoutMs": 15000
      },
      "dingtalk": {
        "type": "dingtalk",
        "clientId": "${DINGTALK_CLIENT_ID}",
        "clientSecret": "${DINGTALK_CLIENT_SECRET}",
        "eventMode": "stream",
        "respondToMentionsOnly": true
      }
    },
    "routes": {
      "ops": {
        "adapter": "feishu",
        "recipient": "oc_xxx"
      }
    },
    "bridge": {
      "enabled": true
    }
  }
}
```

### Bridge extensions

The bridge answers each incoming message from a child Pi process started with
`--offline --no-extensions`, so installed extensions never load implicitly (the
channel extension itself included, which keeps a child from opening a second
Stream connection). List the extension sources a child session may load in
`bridge.extensions`; every entry is passed as a repeatable `-e <source>`, using
the same path / npm / git sources `pi --extension` accepts:

```json
{
  "pi-channels": {
    "bridge": {
      "enabled": true,
      "extensions": ["npm:@example/pi-memory", "./local-extension.ts"]
    }
  }
}
```

Blank, duplicate and flag-like entries are ignored. Because the child runs
offline, `npm:` / `git:` entries are loaded from the user-scope install instead
of being fetched — install the package first (`pi install npm:@example/pi-memory`),
or the entry is skipped. Omit the key to keep child sessions free of extensions.

### Bridge commands

With `bridge.commands` enabled (the default), a chat can control its own conversation with these messages:

- `/status` — bridge activity counters.
- `/abort` — stop the prompt that is currently running for this chat.
- `/new` — start a clean conversation: abort the running prompt, discard queued messages (their temporary attachments are cleaned up), and delete the persisted session file at `.pi/channel-sessions/<adapter>-<hash>.jsonl`, so the next message does not resume the old history.

Messages sharing the same persisted conversation also share a queue. In Feishu, this includes the main chat and its threads: `/abort` and `/new` apply to that shared conversation, while replies still go to the original chat or thread.

`/new` waits for the aborted child process to exit before deleting the file, because Pi rewrites the whole session file when it saves. New prompts wait until all overlapping resets finish. Bridge turns mirrored to the local pi-agent API by `bridge.persistSessions` are not removed by `/new`.

### Feishu modes

WebSocket is the default and recommended mode because it does not require a public callback URL:

```json
{
  "type": "feishu",
  "appId": "${FEISHU_APP_ID}",
  "appSecret": "${FEISHU_APP_SECRET}",
  "eventMode": "websocket",
  "respondToMentionsOnly": true,
  "allowedChatIds": ["oc_xxx"]
}
```

Use HTTP callback mode when the deployment already exposes a Feishu event URL. The SDK handles challenge responses, token verification, and encrypted event payloads. `encryptKey` is required in HTTP mode because it is used to verify ordinary event signatures; `verificationToken` alone is not sufficient:

```json
{
  "type": "feishu",
  "appId": "${FEISHU_APP_ID}",
  "appSecret": "${FEISHU_APP_SECRET}",
  "eventMode": "http",
  "verificationToken": "${FEISHU_VERIFICATION_TOKEN}",
  "encryptKey": "${FEISHU_ENCRYPT_KEY}",
  "botOpenId": "ou_xxx",
  "incoming": {
    "port": 8787,
    "path": "/feishu/events"
  }
}
```

Outgoing Markdown uses rich-text `post` messages with `md` elements by default (`"renderMode": "markdown"`), for both direct sends and replies. Markdown tables are passed through unchanged for native rendering; each fenced code block is sent in a separate paragraph so trailing prose is preserved. Ordinary messages remain verbatim `text`. This follows the [Hermes Feishu adapter's post/md approach](https://github.com/NousResearch/hermes-agent/blob/ecac27c0af86064c40eeb8097cc20377cf2eee12/plugins/platforms/feishu/adapter.py). If Feishu rejects a post with a nonzero business code (including an explicit HTTP 4xx rejection), the adapter logs `feishu-render-fallback` and retries once as readable plain text; only then are tables expanded into records labeled by their column headings. A rejected text send is reported as an error; ambiguous transport or HTTP 5xx failures are not retried because delivery may already have succeeded. Cancellation is checked before each send attempt; the SDK does not expose an in-flight request cancellation option. Set `"renderMode": "text"` to retain verbatim plain-text delivery for all messages.

Set `"eventMode": "off"` for outgoing-only usage.

### DingTalk modes

Create a DingTalk internal app, add the bot capability, select Stream mode, and publish it. Copy the Client ID and Client Secret into the adapter config:

```json
{
  "type": "dingtalk",
  "clientId": "${DINGTALK_CLIENT_ID}",
  "clientSecret": "${DINGTALK_CLIENT_SECRET}",
  "robotCode": "${DINGTALK_ROBOT_CODE}",
  "eventMode": "stream",
  "respondToMentionsOnly": true,
  "allowedConversationIds": ["cid_xxx"]
}
```

Incoming replies use the per-message `sessionWebhook` when available. Active route sends use DingTalk's group message OpenAPI with the route recipient as the conversation/openConversationId. `robotCode` defaults to `clientId` when omitted.

Set `"eventMode": "off"` when the bot should only send messages.

### WeCom modes

Create an intelligent bot in the WeCom admin console, choose API mode, and select the long connection option. Copy the Bot ID and Secret into the adapter config:

```json
{
  "type": "wecom",
  "botId": "${WECOM_BOT_ID}",
  "secret": "${WECOM_BOT_SECRET}",
  "eventMode": "websocket",
  "allowedChatIds": ["wr_xxx"]
}
```

Set `"eventMode": "off"` when the bot should only send messages.

## Tool

```text
notify(action: "send", adapter: "ops", text: "hello")
notify(action: "list")
notify(action: "test", adapter: "ops")
```

For Feishu, recipients default to `chat_id`. Prefix the recipient to override the receive id type:

```text
chat_id:oc_xxx
open_id:ou_xxx
user_id:abc123
email:name@example.com
```

For WeCom intelligent bots, recipients are the conversation ids used by the Bot API. In a group, send one message to the bot and use route capture to fill the group `chatid`; for one-to-one pushes, use the target user's userid:

```text
wr_xxx
zhangsan
```

The intelligent bot adapter uses the WebSocket Bot API, so long connection mode does not require a public callback URL.

For DingTalk app bots, send one message to the bot and use route capture to fill the group conversation id:

```text
cid_xxx
```

## Events

- `channel:send`
- `channel:receive`
- `channel:register`
- `channel:remove`
- `channel:list`

## Commands

```text
/channel list
/channel reload
/channel bridge on
/channel bridge off
/channel bridge status
```
