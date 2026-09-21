import { pathToFileURL } from "node:url";

const API = "https://jkt48.com/api/v1";
const CATEGORIES = new Set(["PHOTOCARD", "TWO_SHOT", "DIGITAL_PHOTOBOOK", "VIDEO_CALL"]);
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "Restock-Exclusive/1.0 (+https://github.com/SergioWinn/Restock-Exclusive)",
};

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

export function selectEvents(payload, trackedCodes = [], nowMs = Date.now()) {
  const outer = record(payload)?.data;
  const values = Array.isArray(outer) ? outer : Array.isArray(record(outer)?.data) ? record(outer).data : [];
  const tracked = new Set(trackedCodes);
  // ponytail: 45-day discovery window limits upstream calls; widen if JKT48 opens sales earlier.
  const cutoff = nowMs - 45 * 86_400_000;
  const seen = new Set();
  return values.flatMap((value) => {
    const item = record(value);
    const code = typeof item?.code === "string" ? item.code.trim() : "";
    const category = typeof item?.category === "string" ? item.category.trim().toUpperCase() : "";
    const validFrom = Date.parse(typeof item?.valid_date_from === "string" ? item.valid_date_from : "");
    if (!code || seen.has(code) || !CATEGORIES.has(category) || (!tracked.has(code) && !(validFrom >= cutoff))) return [];
    seen.add(code);
    return [{ code, category, title: typeof item?.title === "string" ? item.title.trim() || code : code }];
  }).slice(0, 30);
}

async function json(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const challenge = response.headers.get("cf-mitigated") === "challenge" ? " Cloudflare challenge" : "";
    throw new Error(`HTTP ${response.status}${challenge} for ${new URL(url).pathname}`);
  }
  return response.json();
}

export async function poll() {
  const worker = process.env.WORKER_URL?.replace(/\/$/, "");
  const token = process.env.INGEST_TOKEN;
  if (!worker || !token) throw new Error("Missing WORKER_URL or INGEST_TOKEN");
  const authorization = { Authorization: `Bearer ${token}` };
  const status = await json(`${worker}/poll-status`, { headers: authorization });
  if (!status.active) return console.log("Monitoring OFF; skipping JKT48 requests.");

  const events = selectEvents(await json(`${API}/exclusives?lang=id`, { headers: HEADERS }), status.trackedEventCodes);
  const results = [];
  for (const event of events) {
    try {
      const bonus = await json(`${API}/exclusives/${encodeURIComponent(event.code)}/bonus?lang=id`, { headers: HEADERS });
      results.push({ event, bonus });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HTTP 404 ")) continue;
      throw error;
    }
  }

  const result = await json(`${worker}/ingest`, {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ results }),
  });
  console.log(`Updated ${result.events} events / ${result.stocks} slots; ${result.restocks} restocks.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await poll();
