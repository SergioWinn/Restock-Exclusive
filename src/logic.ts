export type EventInfo = { code: string; title: string; category: string };

export type Stock = {
  eventCode: string;
  eventTitle: string;
  category: string;
  session: string;
  date: string;
  startTime: string;
  lane: string;
  member: string;
  quota: number;
};

export type Snapshot = {
  checkedAt: string;
  events: string[];
  items: Record<string, Stock>;
  errors: string[];
};

export type StockKind = "mng" | "2shot" | "vc";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseEvents(payload: Record<string, unknown>, categories: Set<string>): EventInfo[] {
  const outer = payload.data;
  const nested = record(outer)?.data;
  const values = Array.isArray(outer) ? outer : Array.isArray(nested) ? nested : [];

  return values.flatMap((value): EventInfo[] => {
    const item = record(value);
    const code = text(item?.code);
    const category = text(item?.category).toUpperCase();
    if (!code || !categories.has(category)) return [];
    return [{ code, category, title: text(item?.title) || code }];
  });
}

export function parseStocks(event: EventInfo, payload: Record<string, unknown>): Record<string, Stock> {
  if (!Array.isArray(payload.data)) throw new Error(`Invalid bonus data for ${event.code}`);
  const stocks: Record<string, Stock> = {};

  for (const rawSession of payload.data) {
    const session = record(rawSession);
    if (!session || !Array.isArray(session.session_members)) {
      throw new Error(`Invalid bonus session for ${event.code}`);
    }

    for (const rawMember of session.session_members) {
      const member = record(rawMember);
      const quota = member?.available_quota;
      const name = text(member?.member_name);
      if (!member || !name || typeof quota !== "number" || !Number.isInteger(quota) || quota < 0) {
        throw new Error(`Invalid bonus member for ${event.code}`);
      }

      const stock: Stock = {
        eventCode: event.code,
        eventTitle: event.title,
        category: event.category,
        session: text(session.label),
        date: text(session.date).slice(0, 10),
        startTime: text(session.start_time).slice(0, 5),
        lane: text(member.label),
        member: name,
        quota,
      };
      const key = text(member.session_detail_code)
        || [event.code, stock.date, stock.startTime, stock.lane, name].join("|").toLocaleLowerCase("id-ID");
      stocks[key] = stock;
    }
  }
  return stocks;
}

export function detectRestocks(previous: Snapshot | null, current: Snapshot): Stock[] {
  if (!previous) return [];
  const knownEvents = new Set(previous.events);
  return Object.entries(current.items).flatMap(([key, stock]) => {
    if (!knownEvents.has(stock.eventCode)) return [];
    const previousQuota = previous.items[key]?.quota ?? 0;
    return stock.quota > previousQuota ? [stock] : [];
  });
}

export function snapshotFromIngest(payload: unknown, categories: Set<string>, checkedAt: string): Snapshot {
  const results = record(payload)?.results;
  if (!Array.isArray(results) || results.length > 30) throw new Error("Invalid ingest results");

  const events: string[] = [];
  const items: Record<string, Stock> = {};
  for (const rawResult of results) {
    const result = record(rawResult);
    const event = parseEvents({ data: [result?.event] }, categories)[0];
    const bonus = record(result?.bonus);
    if (!event || !bonus || events.includes(event.code)) throw new Error("Invalid ingest event");
    events.push(event.code);
    Object.assign(items, parseStocks(event, bonus));
    if (Object.keys(items).length > 5_000) throw new Error("Too many stock items");
  }
  return { checkedAt, events, items, errors: [] };
}

export function formatRestockSummary(stocks: Stock[]): string {
  return [
    "🔔 Restock terdeteksi",
    ...stocks.map((stock) => [
      `\n${stock.eventTitle}`,
      `${stock.date} · ${stock.session}${stock.startTime ? ` (${stock.startTime} WIB)` : ""}`,
      `${stock.lane || "Tanpa jalur"} · ${stock.member} — ${stock.quota} tersisa`,
    ].join("\n")),
  ].join("\n");
}

function stockKind(category: string): StockKind | null {
  if (category === "PHOTOCARD") return "mng";
  if (category === "TWO_SHOT") return "2shot";
  if (category === "DIGITAL_PHOTOBOOK" || category === "VIDEO_CALL") return "vc";
  return null;
}

export function stockEvents(snapshot: Snapshot | null, kind: StockKind) {
  const events = new Map<string, { title: string; quota: number; slots: number; dates: Set<string> }>();
  for (const stock of Object.values(snapshot?.items ?? {})) {
    if (stockKind(stock.category) !== kind) continue;
    const event = events.get(stock.eventCode) ?? { title: stock.eventTitle, quota: 0, slots: 0, dates: new Set<string>() };
    event.quota += stock.quota;
    event.slots += 1;
    if (stock.date) event.dates.add(stock.date);
    events.set(stock.eventCode, event);
  }
  return [...events.entries()]
    .map(([code, event]) => ({ ...event, code, dates: [...event.dates].sort() }))
    .sort((a, b) => a.title.localeCompare(b.title, "id-ID"));
}

export function formatStockSummary(snapshot: Snapshot | null, kind: StockKind, nowMs = Date.now()): string {
  const labels = { mng: "Meet & Greet", "2shot": "2Shot", vc: "Video Call" };
  if (!snapshot) return `📦 ${labels[kind]}\n\nBelum ada data stok.`;

  const checkedAt = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(snapshot.checkedAt));
  const stale = nowMs - Date.parse(snapshot.checkedAt) > 15 * 60_000
    ? "⚠️ Data belum live/lebih dari 15 menit.\n"
    : "";
  const lines = stockEvents(snapshot, kind)
    .map((event) => {
      const dates = event.dates.join(", ");
      return `• ${event.title}\n  ${event.quota} tersisa · ${event.slots} slot${dates ? ` · ${dates}` : ""}\n  ${event.code}`;
    });

  return [`📦 Sisa ${labels[kind]} per event`, `Diperbarui: ${checkedAt} WIB`, stale, lines.length ? lines.join("\n\n") : "Tidak ada event dengan data stok."].filter(Boolean).join("\n");
}

export function formatEventMemberSummary(snapshot: Snapshot | null, eventCode: string, nowMs = Date.now()): string {
  if (!snapshot) return "Belum ada data stok.";
  const stocks = Object.values(snapshot.items).filter((stock) => stock.eventCode === eventCode);
  if (!stocks.length) return "Event tidak ditemukan pada snapshot stok.";

  const available = stocks
    .filter((stock) => stock.quota > 0)
    .sort((a, b) => a.date.localeCompare(b.date)
      || a.startTime.localeCompare(b.startTime)
      || a.session.localeCompare(b.session, "id-ID")
      || a.lane.localeCompare(b.lane, "id-ID")
      || a.member.localeCompare(b.member, "id-ID"));
  const soldOut = stocks.length - available.length;
  const checkedAt = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(snapshot.checkedAt));
  const stale = nowMs - Date.parse(snapshot.checkedAt) > 15 * 60_000 ? "⚠️ Data belum live/lebih dari 15 menit.\n" : "";
  const sessions = new Map<string, Stock[]>();
  for (const stock of available) {
    const key = [stock.date, stock.startTime, stock.session].join("|");
    sessions.set(key, [...(sessions.get(key) ?? []), stock]);
  }
  const lines = [...sessions.values()].flatMap((sessionStocks) => {
    const first = sessionStocks[0];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(first.date)
      ? new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${first.date}T00:00:00+07:00`))
      : first.date || "Tanggal tidak tersedia";
    const session = first.session || "Sesi";
    const time = first.startTime ? ` (${first.startTime} WIB)` : "";
    return [
      `📅 ${date} · ${session}${time}`,
      ...sessionStocks.map((stock) => `• ${stock.lane || "Tanpa jalur"} · ${stock.member} — ${stock.quota} tersisa`),
      "",
    ];
  });
  return [
    `📋 ${stocks[0].eventTitle}`,
    `Diperbarui: ${checkedAt} WIB`,
    stale,
    lines.length ? lines.join("\n").trimEnd() : "Semua sesi/member habis.",
    soldOut ? `\n${soldOut} slot tanpa stok.` : "",
  ].filter(Boolean).join("\n");
}

export function splitTelegramText(message: string, limit = 3_900): string[] {
  const pages: string[] = [];
  let page = "";
  for (const line of message.split("\n")) {
    if (`${page}${page ? "\n" : ""}${line}`.length <= limit) {
      page += `${page ? "\n" : ""}${line}`;
      continue;
    }
    if (page) pages.push(page);
    page = line;
  }
  if (page) pages.push(page);
  return pages;
}
