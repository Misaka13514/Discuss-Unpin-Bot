# Discuss Unpin Bot

A lightweight, 100% private Telegram bot running on Cloudflare Workers. It automatically unpins posts forwarded from linked channels in discussion groups.

## 🔒 Why Self-Host?

Telegram bots in groups with **Admin permissions** or **Privacy Mode disabled** automatically receive **every single message** sent in the group.

Using a public, third-party hosted bot exposes your entire group chat history to external servers. By self-hosting this bot:

- **100% Private**: Webhooks route directly to your personal Cloudflare account.
- **Zero Logging**: Messages are processed in-memory and never stored.
- **Free Forever**: Operates well within Cloudflare's free tier (Workers & KV).

## ✨ Features

- **Auto-Unpin**: Unpins channel-forwarded posts without affecting manual admin pins.
- **Whitelist Mode**: Protects against unauthorized group adds with auto-leave & admin alerts.
- **Admin Dashboard**: Manage active groups, toggle whitelist, and leave chats via inline buttons.

## 🚀 Quick Setup

### 1. Telegram Bot Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and get your `BOT_TOKEN`.
2. **Disable Privacy Mode** in [@BotFather](https://t.me/BotFather):
   - Send `/setprivacy`
   - Select your bot
   - Choose **Disable** _(Ensures channel forwards are always received)_
3. Get your numeric Telegram User ID from [@userinfobot](https://t.me/userinfobot) (`ADMIN_USER_ID`).

### 2. Deploy to Cloudflare Workers

1. Create a **Worker** in Cloudflare and paste `worker.js`.
2. Create a **KV Namespace** named `CHAT_KV` and bind it as `CHAT_KV`.
3. Set **Environment Variables**:
   - `BOT_TOKEN`: `<Your Bot Token>`
   - `ADMIN_USER_ID`: `<Your User ID>`
4. Deploy the Worker, then visit in your browser to activate:
   ```text
   https://<your-worker-subdomain>.workers.dev/set-webhook
   ```

### 3. Add to Group

1. Add the bot to your linked discussion group.
2. Promote it to **Admin** with **Pin Messages** permission. Done!

## 🕹️ Admin Commands

- `/chats` - View and manage groups via interactive UI
- `/wl` - Show whitelist status & commands (`/wl on|off`, `/wl add|del <id>`)
- `/leave <id>` - Leave a group remotely

## 📄 License

[WTFPL](LICENSE)
