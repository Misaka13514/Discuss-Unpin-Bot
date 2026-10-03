// Configuration Constants
const PAGE_SIZE = 5;
const GITHUB_REPO = "https://github.com/Misaka13514/Discuss-Unpin-Bot";

// Centralized Command Registry
const PUBLIC_COMMANDS = [
  { command: "start", description: "Show usage instructions" },
];

const ADMIN_COMMANDS = [
  { command: "chats", description: "View managed chats & controls" },
  { command: "whitelist", description: "Manage whitelist settings" },
  { command: "leave", description: "Leave a chat by ID (/leave <id>)" },
  { command: "start", description: "Show usage instructions" },
];

// In-Memory Cache & States
let memoryWlCache = null;
let memoryWlExpiry = 0;
const WL_CACHE_TTL_MS = 60 * 1000;

// ==========================================
// 1. Telegram API & HTTP Utility Helpers
// ==========================================

// Centralized Telegram Bot API caller with automatic HTML mode and error filtering
async function tgCall(token, method, params = {}) {
  if (params.text && !params.parse_mode) params.parse_mode = "HTML";

  const isPost = Object.keys(params).length > 0;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: isPost ? "POST" : "GET",
    headers: isPost ? { "Content-Type": "application/json" } : undefined,
    body: isPost ? JSON.stringify(params) : undefined,
  });

  const data = await res.json();
  if (!data.ok) {
    const desc = data.description || "";
    // Ignore benign errors (e.g. unchanged edit UI, already unpinned)
    if (
      !desc.includes("message is not modified") &&
      !desc.includes("message to unpin not found") &&
      !desc.includes("CHAT_NOT_MODIFIED")
    ) {
      console.error(
        `[Telegram API Error] ${method}: [${data.error_code}] ${desc}`,
      );
    }
  }
  return data;
}

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const textResponse = (text, status = 200) => new Response(text, { status });

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function getDerivedSecretToken(botToken) {
  const encoder = new TextEncoder();
  const data = encoder.encode(botToken + "_TG_AUTO_SECRET_SALT");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Generate usage guide dynamically from command registry
function getUsageGuide(isAdmin) {
  const base =
    `<b>Discuss Unpin Bot</b>\n\n` +
    `Automatically unpins auto-forwarded posts from linked channels in discussion groups.\n\n` +
    `<b>Setup:</b>\n` +
    `1. Add bot to your linked discussion group.\n` +
    `2. Promote to Admin (<b>Pin Messages</b> permission required).\n\n` +
    `<b>GitHub:</b> <a href="${GITHUB_REPO}">${GITHUB_REPO.replace("https://github.com/", "")}</a>`;

  if (!isAdmin) return base;

  const adminCmds = ADMIN_COMMANDS.filter((c) => c.command !== "start")
    .map((c) => `• /${c.command} - ${escapeHtml(c.description)}`)
    .join("\n");

  return `${base}\n\n<b>Admin Commands:</b>\n${adminCmds}`;
}

// ==========================================
// 2. Cloudflare KV Storage Helpers
// ==========================================

async function recordChat(env, chat) {
  if (!env.CHAT_KV || !chat?.id) return;
  await env.CHAT_KV.put(
    `chat:${chat.id}`,
    JSON.stringify({
      id: chat.id,
      title: chat.title || chat.username || "Untitled Chat",
      type: chat.type,
      updated_at: Date.now(),
    }),
  );
}

async function deleteChatRecord(env, chatId) {
  if (!env.CHAT_KV) return;
  await env.CHAT_KV.delete(`chat:${chatId}`);
}

// Paged chat fetcher: Avoids N+1 calls and subrequest limit exhaustion
async function getChatsPaged(env, page = 1, pageSize = PAGE_SIZE) {
  if (!env.CHAT_KV) {
    return { chats: [], total: 0, currentPage: 1, totalPages: 1 };
  }
  const list = await env.CHAT_KV.list({ prefix: "chat:" });
  const total = list.keys.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const currentPage = Math.max(1, Math.min(page, totalPages));

  const startIdx = (currentPage - 1) * pageSize;
  const pagedKeys = list.keys.slice(startIdx, startIdx + pageSize);

  const records = await Promise.all(
    pagedKeys.map((k) => env.CHAT_KV.get(k.name)),
  );

  const chats = records
    .filter(Boolean)
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return { chats, total, currentPage, totalPages };
}

// Whitelist getter with in-memory caching to save daily KV read quotas
async function getWhitelistConfig(env) {
  const now = Date.now();
  if (memoryWlCache && now < memoryWlExpiry) {
    return memoryWlCache;
  }

  const defaultState = { enabled: false, allowed_ids: [] };
  if (!env.CHAT_KV) return defaultState;

  const raw = await env.CHAT_KV.get("config:whitelist");
  if (!raw) {
    memoryWlCache = defaultState;
  } else {
    try {
      memoryWlCache = JSON.parse(raw);
    } catch {
      memoryWlCache = defaultState;
    }
  }
  memoryWlExpiry = now + WL_CACHE_TTL_MS;
  return memoryWlCache;
}

async function saveWhitelistConfig(env, config) {
  memoryWlCache = config;
  memoryWlExpiry = Date.now() + WL_CACHE_TTL_MS;
  if (!env.CHAT_KV) return;
  await env.CHAT_KV.put("config:whitelist", JSON.stringify(config));
}

// ==========================================
// 3. Command Setup & Whitelist Enforcement
// ==========================================

async function setupBotCommands(botToken, adminUserId) {
  const publicCommands = tgCall(botToken, "setMyCommands", {
    commands: PUBLIC_COMMANDS,
    scope: { type: "all_private_chats" },
  });

  const adminCommands = adminUserId
    ? tgCall(botToken, "setMyCommands", {
        commands: ADMIN_COMMANDS,
        scope: {
          type: "chat",
          chat_id: isNaN(adminUserId) ? adminUserId : parseInt(adminUserId, 10),
        },
      })
    : Promise.resolve(null);

  const [pubRes, admRes] = await Promise.all([publicCommands, adminCommands]);
  return { public_commands: pubRes, admin_commands: admRes };
}

async function notifyAdminUnauthorizedLeave(
  env,
  botToken,
  chat,
  triggeredBy = null,
) {
  if (!env.ADMIN_USER_ID) return;

  const userLabel = triggeredBy
    ? triggeredBy.username
      ? `@${triggeredBy.username}`
      : escapeHtml(triggeredBy.first_name || `ID: ${triggeredBy.id}`)
    : "Unknown";

  const text =
    `🚨 <b>Unauthorized Chat Auto-Leave Alert</b>\n\n` +
    `The bot automatically left an unauthorized group:\n` +
    `• <b>Title:</b> ${escapeHtml(chat.title || "Untitled")}\n` +
    `• <b>ID:</b> <code>${chat.id}</code>\n` +
    `• <b>Type:</b> <code>${chat.type}</code>\n` +
    `• <b>Triggered By:</b> ${userLabel}\n\n` +
    `<i>If intentional, tap the button below to whitelist this chat before re-adding.</i>`;

  await tgCall(botToken, "sendMessage", {
    chat_id: env.ADMIN_USER_ID,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `🛡️ Add ${chat.id} to Whitelist`,
            callback_data: `wl_quick_add:${chat.id}`,
          },
        ],
      ],
    },
  });
}

async function handleUnauthorizedLeave(
  env,
  botToken,
  chat,
  triggeredBy = null,
) {
  const chatId = chat.id;

  // Deduplication check using KV lock (60 seconds TTL)
  if (env.CHAT_KV) {
    const lockKey = `lock:leave:${chatId}`;
    if (await env.CHAT_KV.get(lockKey)) return;
    await env.CHAT_KV.put(lockKey, "1", { expirationTtl: 60 });
  }

  const leaveData = await tgCall(botToken, "leaveChat", { chat_id: chatId });
  await deleteChatRecord(env, chatId);

  if (leaveData.ok) {
    await notifyAdminUnauthorizedLeave(env, botToken, chat, triggeredBy);
  }
}

async function enforceWhitelist(env, botToken, chat, user) {
  const wlConfig = await getWhitelistConfig(env);
  if (wlConfig.enabled && !wlConfig.allowed_ids.includes(String(chat.id))) {
    console.warn(
      `[Security] Unauthorized chat ${chat.id} intercepted. Leaving...`,
    );
    await handleUnauthorizedLeave(env, botToken, chat, user);
    return false;
  }
  return true;
}

// ==========================================
// 4. View Rendering & UI Helpers
// ==========================================

function renderChatsPage(pagedData, whitelistConfig) {
  const { chats, total, currentPage, totalPages } = pagedData;
  const wlStatus = whitelistConfig.enabled ? "🟢 ENABLED" : "⚪ DISABLED";

  if (total === 0) {
    return {
      text: `📋 <b>Managed Chats</b>\nWhitelist: <b>${wlStatus}</b>\n\nℹ️ <i>No active groups recorded yet.</i>`,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: whitelistConfig.enabled
                ? "Disable Whitelist 🔴"
                : "Enable Whitelist 🟢",
              callback_data: `wl_status:${!whitelistConfig.enabled}:${currentPage}`,
            },
          ],
        ],
      },
    };
  }

  const startIdx = (currentPage - 1) * PAGE_SIZE;
  let text = `📋 <b>Managed Chats (${total} total)</b>\n🛡️ Whitelist: <b>${wlStatus}</b>\nPage ${currentPage} of ${totalPages}\n\n`;
  const inlineKeyboard = [];

  chats.forEach((c, idx) => {
    const isWl = whitelistConfig.allowed_ids.includes(String(c.id));
    const title = escapeHtml(c.title);
    const shortTitle =
      c.title.length > 15 ? c.title.slice(0, 13) + ".." : c.title;

    text += `${startIdx + idx + 1}. <b>${title}</b> ${isWl ? "<code>[WL ✅]</code>" : "<code>[WL ❌]</code>"}\n   • ID: <code>${c.id}</code> | Type: <code>${c.type}</code>\n\n`;

    inlineKeyboard.push([
      {
        text: isWl ? "🛡️ -WL" : "🛡️ +WL",
        callback_data: `wl_toggle:${c.id}:${currentPage}`,
      },
      {
        text: `🚪 Leave: ${shortTitle}`,
        callback_data: `leave:${c.id}:${currentPage}`,
      },
    ]);
  });

  const navRow = [];
  if (currentPage > 1)
    navRow.push({ text: "⬅️ Prev", callback_data: `page:${currentPage - 1}` });
  navRow.push({
    text: `📄 ${currentPage}/${totalPages}`,
    callback_data: `page:${currentPage}`,
  });
  if (currentPage < totalPages)
    navRow.push({ text: "Next ➡️", callback_data: `page:${currentPage + 1}` });

  inlineKeyboard.push(navRow);
  inlineKeyboard.push([
    {
      text: whitelistConfig.enabled
        ? "Disable Whitelist 🔴"
        : "Enable Whitelist 🟢",
      callback_data: `wl_status:${!whitelistConfig.enabled}:${currentPage}`,
    },
    { text: "🔄 Refresh", callback_data: `page:${currentPage}` },
  ]);

  return {
    text: text.trim(),
    reply_markup: { inline_keyboard: inlineKeyboard },
  };
}

// Refresh and edit the chat management view in-place
async function refreshChatsView(env, botToken, query, page) {
  const [pagedData, wlConfig] = await Promise.all([
    getChatsPaged(env, page),
    getWhitelistConfig(env),
  ]);
  const view = renderChatsPage(pagedData, wlConfig);

  await tgCall(botToken, "editMessageText", {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: view.text,
    reply_markup: view.reply_markup,
  });
}

// ==========================================
// 5. Worker Entrypoint
// ==========================================

export default {
  async fetch(request, env) {
    const botToken = env.BOT_TOKEN;
    if (!botToken) return textResponse("Missing BOT_TOKEN in environment", 500);

    const url = new URL(request.url);
    const expectedSecret = await getDerivedSecretToken(botToken);

    // Endpoint: Initialize Webhook and Commands
    if (request.method === "GET" && url.pathname === "/set-webhook") {
      const webhookRes = await tgCall(botToken, "setWebhook", {
        url: url.origin,
        secret_token: expectedSecret,
        allowed_updates: ["message", "my_chat_member", "callback_query"],
      });
      const commandsRes = await setupBotCommands(botToken, env.ADMIN_USER_ID);
      return jsonResponse({ webhook: webhookRes, commands: commandsRes });
    }

    // Endpoint: Refresh Commands Only
    if (request.method === "GET" && url.pathname === "/set-commands") {
      return jsonResponse(await setupBotCommands(botToken, env.ADMIN_USER_ID));
    }

    // Endpoint: Check Webhook Info
    if (request.method === "GET" && url.pathname === "/get-webhook") {
      return jsonResponse(await tgCall(botToken, "getWebhookInfo"));
    }

    if (request.method !== "POST") return textResponse("📌 Bot is running.");

    // Webhook authentication check
    if (
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret
    ) {
      return textResponse("Unauthorized", 403);
    }

    try {
      const update = await request.json();

      // -------------------------------------------------------------
      // Event: Membership updates
      // -------------------------------------------------------------
      if (update.my_chat_member) {
        const { chat, new_chat_member, from } = update.my_chat_member;
        const status = new_chat_member?.status;

        if (status === "member" || status === "administrator") {
          if (await enforceWhitelist(env, botToken, chat, from)) {
            await recordChat(env, chat);
          }
        } else if (status === "left" || status === "kicked") {
          await deleteChatRecord(env, chat.id);
        }
        return textResponse("OK");
      }

      // -------------------------------------------------------------
      // Event: Interactive Callback Queries
      // -------------------------------------------------------------
      if (update.callback_query) {
        const query = update.callback_query;
        const fromId = String(query.from.id);
        const data = query.data || "";

        if (!env.ADMIN_USER_ID || fromId !== String(env.ADMIN_USER_ID)) {
          await tgCall(botToken, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: "Unauthorized.",
            show_alert: true,
          });
          return textResponse("OK");
        }

        // Action: Quick Add to Whitelist from Alert
        if (data.startsWith("wl_quick_add:")) {
          const targetId = data.replace("wl_quick_add:", "");
          const wl = await getWhitelistConfig(env);
          if (!wl.allowed_ids.includes(targetId)) {
            wl.allowed_ids.push(targetId);
            await saveWhitelistConfig(env, wl);
          }
          await tgCall(botToken, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: `✅ Whitelisted ${targetId}`,
          });
          await tgCall(botToken, "editMessageText", {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: `${query.message.text}\n\n✅ <b>Successfully Whitelisted!</b> You can now re-invite the bot.`,
          });
          return textResponse("OK");
        }

        // Action: Pagination Navigation
        if (data.startsWith("page:")) {
          const page = parseInt(data.replace("page:", ""), 10) || 1;
          await refreshChatsView(env, botToken, query, page);
          await tgCall(botToken, "answerCallbackQuery", {
            callback_query_id: query.id,
          });
          return textResponse("OK");
        }

        // Action: Toggle Whitelist Switch
        if (data.startsWith("wl_status:")) {
          const [, state, page] = data.split(":");
          const wl = await getWhitelistConfig(env);
          wl.enabled = state === "true";
          await saveWhitelistConfig(env, wl);

          await refreshChatsView(env, botToken, query, parseInt(page, 10));
          await tgCall(botToken, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: wl.enabled
              ? "🛡️ Whitelist enabled."
              : "⚪ Whitelist disabled.",
          });
          return textResponse("OK");
        }

        // Action: Toggle Chat Whitelist Membership
        if (data.startsWith("wl_toggle:")) {
          const [, targetId, page] = data.split(":");
          const wl = await getWhitelistConfig(env);
          const isMember = wl.allowed_ids.includes(targetId);

          wl.allowed_ids = isMember
            ? wl.allowed_ids.filter((id) => id !== targetId)
            : [...wl.allowed_ids, targetId];
          await saveWhitelistConfig(env, wl);

          await refreshChatsView(env, botToken, query, parseInt(page, 10));
          await tgCall(botToken, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: isMember
              ? `Removed ${targetId} from whitelist`
              : `Added ${targetId} to whitelist`,
          });
          return textResponse("OK");
        }

        // Action: Leave Chat
        if (data.startsWith("leave:")) {
          const [, targetId, page] = data.split(":");
          const res = await tgCall(botToken, "leaveChat", {
            chat_id: targetId,
          });
          await deleteChatRecord(env, targetId);

          await tgCall(botToken, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: res.ok
              ? `✅ Left chat ${targetId}`
              : `❌ Failed: ${res.description}`,
            show_alert: !res.ok,
          });
          await refreshChatsView(env, botToken, query, parseInt(page, 10));
          return textResponse("OK");
        }

        return textResponse("OK");
      }

      // -------------------------------------------------------------
      // Event: Messages
      // -------------------------------------------------------------
      const message = update.message;
      if (!message?.chat) return textResponse("OK");

      const chatId = message.chat.id;
      const chatType = message.chat.type;

      // Sub-event: Handle Group Migration to Supergroup
      if (message.migrate_to_chat_id) {
        const oldId = chatId;
        const newId = message.migrate_to_chat_id;

        await deleteChatRecord(env, oldId);
        await recordChat(env, {
          id: newId,
          title: message.chat.title || "Migrated Supergroup",
          type: "supergroup",
        });

        // Migrate whitelist ID seamlessly
        const wl = await getWhitelistConfig(env);
        if (wl.allowed_ids.includes(String(oldId))) {
          wl.allowed_ids = wl.allowed_ids.map((id) =>
            id === String(oldId) ? String(newId) : id,
          );
          await saveWhitelistConfig(env, wl);
        }
        return textResponse("OK");
      }

      // Sub-event: Private Chat Commands
      if (chatType === "private") {
        const text = (message.text || "").trim();
        const isAdmin =
          Boolean(env.ADMIN_USER_ID) &&
          String(message.from?.id) === String(env.ADMIN_USER_ID);
        const reply = (body, markup) =>
          tgCall(botToken, "sendMessage", {
            chat_id: chatId,
            text: body,
            reply_markup: markup,
          });

        // Command: /chats
        if (isAdmin && text === "/chats") {
          if (!env.CHAT_KV) {
            await reply("⚠️ Cloudflare KV namespace `CHAT_KV` is not bound.");
            return textResponse("OK");
          }
          const [pagedData, wlConfig] = await Promise.all([
            getChatsPaged(env, 1),
            getWhitelistConfig(env),
          ]);
          const view = renderChatsPage(pagedData, wlConfig);
          await reply(view.text, view.reply_markup);
          return textResponse("OK");
        }

        // Command: /whitelist or /wl
        if (
          isAdmin &&
          (text.startsWith("/whitelist") || text.startsWith("/wl"))
        ) {
          const [, subCmd, targetId] = text.split(/\s+/);
          const wl = await getWhitelistConfig(env);
          const cmd = subCmd?.toLowerCase();

          if (cmd === "on" || cmd === "off") {
            wl.enabled = cmd === "on";
            await saveWhitelistConfig(env, wl);
            await reply(
              wl.enabled
                ? "✅ Whitelist <b>ENABLED</b>."
                : "⚪ Whitelist <b>DISABLED</b>.",
            );
            return textResponse("OK");
          }

          if ((cmd === "add" || cmd === "del") && targetId) {
            wl.allowed_ids =
              cmd === "add"
                ? [...new Set([...wl.allowed_ids, targetId])]
                : wl.allowed_ids.filter((id) => id !== targetId);
            await saveWhitelistConfig(env, wl);
            await reply(
              cmd === "add"
                ? `✅ Added <code>${targetId}</code> to whitelist.`
                : `✅ Removed <code>${targetId}</code> from whitelist.`,
            );
            return textResponse("OK");
          }

          const statusText = wl.enabled ? "🟢 ENABLED" : "⚪ DISABLED";
          const idsList =
            wl.allowed_ids.length > 0
              ? wl.allowed_ids.map((id) => `• <code>${id}</code>`).join("\n")
              : "<i>(None)</i>";
          await reply(
            `🛡️ <b>Whitelist Settings</b>\nStatus: <b>${statusText}</b>\n\n<b>Allowed Chats (${wl.allowed_ids.length}):</b>\n${idsList}\n\n<b>Commands:</b>\n• <code>/wl on|off</code>\n• <code>/wl add|del &lt;id&gt;</code>`,
          );
          return textResponse("OK");
        }

        // Command: /leave <chat_id>
        if (isAdmin && text.startsWith("/leave")) {
          const [, targetId] = text.split(/\s+/);
          if (!targetId) {
            await reply("Usage: <code>/leave &lt;chat_id&gt;</code>");
            return textResponse("OK");
          }
          const res = await tgCall(botToken, "leaveChat", {
            chat_id: targetId,
          });
          await deleteChatRecord(env, targetId);
          await reply(
            res.ok
              ? `✅ Successfully left <code>${targetId}</code>.`
              : `❌ Failed: ${res.description}`,
          );
          return textResponse("OK");
        }

        if (text.startsWith("/start")) {
          await reply(getUsageGuide(isAdmin));
          return textResponse("OK");
        }

        if (text.startsWith("/")) {
          await reply("Unknown command. Send /start for usage instructions.");
          return textResponse("OK");
        }

        // Ignore ordinary text, stickers, pictures in private chat without spamming
        return textResponse("OK");
      }

      // Sub-event: Group Message Processing
      if (chatType === "group" || chatType === "supergroup") {
        if (!message.is_automatic_forward) {
          return textResponse("OK");
        }

        if (
          !(await enforceWhitelist(env, botToken, message.chat, message.from))
        ) {
          return textResponse("OK");
        }

        // Unpin auto-forwarded posts from linked channels
        if (message.is_automatic_forward === true) {
          await tgCall(botToken, "unpinChatMessage", {
            chat_id: chatId,
            message_id: message.message_id,
          });
        }
      }

      return textResponse("OK");
    } catch (err) {
      console.error(`[Worker Exception] ${err.stack || err.message}`);
      return textResponse("OK");
    }
  },
};
