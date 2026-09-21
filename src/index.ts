import { handleCommand, isActive, timerAction } from "./control";
import type { MonitorState } from "./control";
import { detectRestocks, formatEventMemberSummary, formatRestockSummary, formatStockSummary, snapshotFromIngest, splitTelegramText, stockEvents } from "./logic";
import type { Snapshot, StockKind } from "./logic";
import profilePhoto from "./bot-profile.bin";

const SNAPSHOT_KEY = "stock-snapshot-v1";
const CONTROL_KEY = "monitor-control-v1";
const PROFILE_READY_KEY = "telegram-webhook-ready-v3";
const WEBHOOK_READY_KEY = "telegram-webhook-ready-v4";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function sendTelegram(env: Env, message: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: true, reply_markup: replyMarkup }),
  });
  const result: unknown = await response.json();
  if (!response.ok || record(result)?.ok !== true) throw new Error(`Telegram API ${response.status}`);
}

async function ensureTelegramWebhook(env: Env): Promise<void> {
  if (await env.STATE.get(WEBHOOK_READY_KEY)) return;
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${env.PUBLIC_BASE_URL}/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  const result: unknown = await response.json();
  if (!response.ok || record(result)?.ok !== true) throw new Error(`Telegram setWebhook ${response.status}`);

  const commandsResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: [
      { command: "on", description: "Aktifkan pemantauan, contoh: /on 3h" },
      { command: "off", description: "Hentikan pemantauan" },
      { command: "status", description: "Lihat status dan sisa waktu" },
      { command: "extend", description: "Tambah waktu, contoh: /extend 2h" },
      { command: "stock", description: "Lihat sisa stok per jenis dan event" },
      { command: "mng", description: "Sisa Meet & Greet per event" },
      { command: "twoshot", description: "Sisa 2Shot per event" },
      { command: "vc", description: "Sisa Video Call per event" },
    ] }),
  });
  const commandsResult: unknown = await commandsResponse.json();
  if (!commandsResponse.ok || record(commandsResult)?.ok !== true) throw new Error(`Telegram setMyCommands ${commandsResponse.status}`);

  const descriptionResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyDescription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      description: "Notifier pribadi untuk memantau restock slot Meet & Greet, 2Shot, dan Video Call JKT48. Gunakan /stock untuk melihat sisa per event, /on 3h untuk mengaktifkan pemantauan, dan /off untuk menghentikannya.",
    }),
  });
  const descriptionResult: unknown = await descriptionResponse.json();
  if (!descriptionResponse.ok || record(descriptionResult)?.ok !== true) throw new Error(`Telegram setMyDescription ${descriptionResponse.status}`);

  const shortDescriptionResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyShortDescription`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ short_description: "Pantau restock Meet & Greet, 2Shot, dan Video Call JKT48 langsung lewat Telegram." }),
  });
  const shortDescriptionResult: unknown = await shortDescriptionResponse.json();
  if (!shortDescriptionResponse.ok || record(shortDescriptionResult)?.ok !== true) throw new Error(`Telegram setMyShortDescription ${shortDescriptionResponse.status}`);

  if (!await env.STATE.get(PROFILE_READY_KEY)) {
    const form = new FormData();
    form.set("photo", JSON.stringify({ type: "static", photo: "attach://profile" }));
    form.set("profile", new Blob([profilePhoto], { type: "image/jpeg" }), "bot-profile.jpg");
    const photoResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyProfilePhoto`, {
      method: "POST",
      body: form,
    });
    const photoResult: unknown = await photoResponse.json();
    if (!photoResponse.ok || record(photoResult)?.ok !== true) throw new Error(`Telegram setMyProfilePhoto ${photoResponse.status}`);
  }

  await env.STATE.put(WEBHOOK_READY_KEY, new Date().toISOString());
  await sendTelegram(env, "📦 Menu stok per event sudah aktif. Gunakan /stock atau tombol MnG, 2Shot, dan VC.");
}

const stockKeyboard = {
  inline_keyboard: [[
    { text: "🎟️ MnG", callback_data: "stock:mng" },
    { text: "📸 2Shot", callback_data: "stock:2shot" },
    { text: "📹 VC", callback_data: "stock:vc" },
  ]],
};

async function sendStock(env: Env, kind: StockKind): Promise<void> {
  const snapshot = await env.STATE.get<Snapshot>(SNAPSHOT_KEY, "json");
  const eventRows = stockEvents(snapshot, kind).map((event) => [{
    text: `👤 ${event.title.length > 44 ? `${event.title.slice(0, 41)}...` : event.title}`,
    callback_data: `event:${event.code}`,
  }]);
  await sendTelegram(env, formatStockSummary(snapshot, kind), { inline_keyboard: [...eventRows, ...stockKeyboard.inline_keyboard] });
}

async function sendEventStock(env: Env, eventCode: string): Promise<void> {
  const snapshot = await env.STATE.get<Snapshot>(SNAPSHOT_KEY, "json");
  const pages = splitTelegramText(formatEventMemberSummary(snapshot, eventCode));
  for (const [index, page] of pages.entries()) {
    await sendTelegram(env, page, index === pages.length - 1 ? stockKeyboard : undefined);
  }
}

async function answerCallback(env: Env, callbackQueryId: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

function sameSecret(received: string, expected: string): boolean {
  const left = new TextEncoder().encode(received);
  const right = new TextEncoder().encode(expected);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
}

function ingestAuthorized(request: Request, env: Env): boolean {
  const authorization = request.headers.get("Authorization") ?? "";
  return Boolean(env.INGEST_TOKEN) && authorization.startsWith("Bearer ")
    && sameSecret(authorization.slice(7), env.INGEST_TOKEN);
}

async function pollStatus(request: Request, env: Env): Promise<Response> {
  if (!ingestAuthorized(request, env)) return new Response("Unauthorized", { status: 401 });
  const [control, snapshot] = await Promise.all([
    env.STATE.get<MonitorState>(CONTROL_KEY, "json"),
    env.STATE.get<Snapshot>(SNAPSHOT_KEY, "json"),
  ]);
  return Response.json({
    active: isActive(control),
    trackedEventCodes: [...new Set(Object.values(snapshot?.items ?? {}).map((stock) => stock.eventCode))],
  });
}

async function ingestSnapshot(request: Request, env: Env): Promise<Response> {
  if (!ingestAuthorized(request, env)) return new Response("Unauthorized", { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 1_000_000) return new Response("Payload too large", { status: 413 });
  const control = await env.STATE.get<MonitorState>(CONTROL_KEY, "json");
  if (!isActive(control)) return new Response("Monitoring is off", { status: 409 });

  try {
    const payload: unknown = await request.json();
    const categories = new Set(env.MONITORED_CATEGORIES.split(",").map((value) => value.trim()).filter(Boolean));
    const current = snapshotFromIngest(payload, categories, new Date().toISOString());
    const previous = await env.STATE.get<Snapshot>(SNAPSHOT_KEY, "json");
    const restocks = detectRestocks(previous, current);
    await env.STATE.put(SNAPSHOT_KEY, JSON.stringify(current));
    for (const page of splitTelegramText(formatRestockSummary(restocks))) {
      if (restocks.length) await sendTelegram(env, page);
    }
    return Response.json({ ok: true, events: current.events.length, stocks: Object.keys(current.items).length, restocks: restocks.length });
  } catch (error) {
    console.error(JSON.stringify({ message: "invalid stock ingest", error: error instanceof Error ? error.message : String(error) }));
    return new Response("Invalid payload", { status: 400 });
  }
}

async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!sameSecret(secret, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("Unauthorized", { status: 401 });
  const size = Number(request.headers.get("content-length") ?? 0);
  if (size > 65_536) return new Response("Payload too large", { status: 413 });

  const payload = record(await request.json());
  const updateId = payload?.update_id;
  if (typeof updateId === "number") {
    const updateKey = `telegram-update:${updateId}`;
    if (await env.STATE.get(updateKey)) return new Response("OK");
    await env.STATE.put(updateKey, "1", { expirationTtl: 86_400 });
  }

  const callback = record(payload?.callback_query);
  const callbackMessage = record(callback?.message);
  const callbackChat = record(callbackMessage?.chat);
  if (typeof callback?.id === "string" && typeof callback?.data === "string"
    && String(callbackChat?.id ?? "") === env.TELEGRAM_CHAT_ID) {
    await answerCallback(env, callback.id);
    if (callback.data.startsWith("stock:")) {
      const kind = callback.data.replace("stock:", "") as StockKind;
      if (["mng", "2shot", "vc"].includes(kind)) await sendStock(env, kind);
    } else if (callback.data.startsWith("event:")) {
      const eventCode = callback.data.replace("event:", "");
      if (/^[A-Za-z0-9_-]{1,48}$/.test(eventCode)) await sendEventStock(env, eventCode);
    }
    return new Response("OK");
  }

  const message = record(payload?.message);
  const chat = record(message?.chat);
  if (String(chat?.id ?? "") !== env.TELEGRAM_CHAT_ID || typeof message?.text !== "string") return new Response("OK");

  const command = message.text.trim().split(/\s+/, 1)[0].toLowerCase().replace(/@[^\s]+$/, "");
  if (command === "/stock") {
    await sendTelegram(env, "Pilih jenis stok yang ingin dilihat:", stockKeyboard);
    return new Response("OK");
  }
  const stockCommands: Partial<Record<string, StockKind>> = { "/mng": "mng", "/twoshot": "2shot", "/2shot": "2shot", "/vc": "vc" };
  const kind = stockCommands[command];
  if (kind) {
    await sendStock(env, kind);
    return new Response("OK");
  }

  const current = await env.STATE.get<MonitorState>(CONTROL_KEY, "json");
  const result = handleCommand(message.text, current);
  if (result.state) await env.STATE.put(CONTROL_KEY, JSON.stringify(result.state));
  try {
    await sendTelegram(env, result.reply);
  } catch (error) {
    console.error(JSON.stringify({ message: "telegram reply failed", error: error instanceof Error ? error.message : String(error) }));
  }
  return new Response("OK");
}

export default {
  async scheduled(_controller, env): Promise<void> {
    await ensureTelegramWebhook(env);
    const current = await env.STATE.get<MonitorState>(CONTROL_KEY, "json");
    const action = timerAction(current);
    if (action.state) await env.STATE.put(CONTROL_KEY, JSON.stringify(action.state));
    if (action.message) await sendTelegram(env, action.message);
  },

  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/telegram" && request.method === "POST") return telegramWebhook(request, env);
    if (url.pathname === "/poll-status" && request.method === "GET") return pollStatus(request, env);
    if (url.pathname === "/ingest" && request.method === "POST") return ingestSnapshot(request, env);
    if (url.pathname !== "/" || request.method !== "GET") return new Response("Not found", { status: 404 });

    const snapshot = await env.STATE.get<Snapshot>(SNAPSHOT_KEY, "json");
    const control = await env.STATE.get<MonitorState>(CONTROL_KEY, "json");
    return Response.json({
      ok: true,
      monitoring: isActive(control),
      activeUntil: isActive(control) ? control?.activeUntil : null,
      initialized: snapshot !== null,
      lastCheck: snapshot?.checkedAt ?? null,
      monitoredEvents: snapshot?.events.length ?? 0,
      monitoredStocks: snapshot ? Object.keys(snapshot.items).length : 0,
      lastErrors: snapshot?.errors ?? [],
    });
  },
} satisfies ExportedHandler<Env>;
