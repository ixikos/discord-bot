# Discord Bot

Handles build notifications, bug reporting, and ClickUp ticket automation via n8n.

## Setup

### 1. Create a Discord Application
1. Go to https://discord.com/developers/applications
2. New Application → Bot tab → Add Bot
3. Enable **Message Content Intent** and **Server Members Intent** under Privileged Gateway Intents
4. Copy the token into `.env` as `DISCORD_TOKEN`
5. OAuth2 → URL Generator → scopes: `bot`, `applications.commands` → permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Embed Links`
6. Use the generated URL to invite the bot to your server

### 2. Get IDs
Right-click your server icon → Copy Server ID → `GUILD_ID`
Right-click your bugs channel → Copy Channel ID → `BUGS_CHANNEL_ID`
Right-click your builds channel → Copy Channel ID → `BUILDS_CHANNEL_ID`

(You need Developer Mode on — User Settings → Advanced → Developer Mode)

### 3. Install and run

```bash
cp .env.example .env
# fill in .env values
npm install
npm start
```

### 4. Keep it running with pm2

```bash
npm install -g pm2
pm2 start index.js --name discord-bot
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

---

## Sending build notifications

From your build machine, POST to the bot's webhook endpoint:

```bash
curl -X POST http://YOUR_MAC_IP:3000/webhook/build \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your_webhook_secret" \
  -d '{
    "status": "success",
    "version": "v1.4.2-dev",
    "platform": "Windows x64",
    "duration": "4m 32s",
    "buildId": "build-123",
    "downloadUrl": "https://your-build-server/builds/123",
    "logsUrl": "https://your-build-server/logs/123"
  }'
```

If the build machine is on the same LAN as your Mac this works with the local IP.
If it's remote, expose port 3000 via Cloudflare Tunnel.

---

## n8n workflows needed

### Bug EOD Batch
- **Trigger**: Schedule (e.g. 6pm daily) OR Webhook at `POST /webhook/bug-eod`
- **Steps**:
  1. Receive `{ bugs: [...] }` array
  2. LLM node — parse and deduplicate, return structured `{ title, description, priority, steps }`
  3. ClickUp node — create task per bug
  4. HTTP Request — POST back to bot at `POST /webhook/tickets-created` with created ticket URLs

### Bug Immediate
- **Trigger**: Webhook at `POST /webhook/bug-immediate`
- Same as above but no deduplication, fires immediately

---

## Adding a new webhook type

1. Add a handler function in `handlers/webhookHandler.js` under the `handlers` object
2. POST to `/webhook/your-type` with `X-Webhook-Secret` header

That's it.
