import assert from "node:assert/strict";
import test from "node:test";

import { detectRestocks, formatEventMemberSummary, formatRestockSummary, formatStockSummary, parseStocks, snapshotFromIngest, splitTelegramText } from "../src/logic.ts";
import { handleCommand, isActive, timerAction } from "../src/control.ts";
import { selectEvents } from "../scripts/poll.mjs";

const event = { code: "EXTEST", title: "Meet & Greet", category: "PHOTOCARD" };

test("detects only increases for events that already have a baseline", () => {
  const oldStock = { eventCode: "EXTEST", eventTitle: "Meet & Greet", category: "PHOTOCARD", session: "Sesi 1", date: "2026-09-21", startTime: "10:00", lane: "Jalur 1", member: "Member A", quota: 0 };
  const previous = { checkedAt: "old", events: ["EXTEST"], items: { slot: oldStock }, errors: [] };
  const current = { checkedAt: "new", events: ["EXTEST"], items: { slot: { ...oldStock, quota: 3 } }, errors: [] };

  assert.deepEqual(detectRestocks(previous, current), [current.items.slot]);
  assert.deepEqual(detectRestocks(null, current), []);
  assert.deepEqual(detectRestocks({ ...previous, events: [] }, current), []);
});

test("parses live bonus stock into a stable slot", () => {
  const stocks = parseStocks(event, { status: true, data: [{
    label: "Sesi 1",
    date: "2026-09-21",
    start_time: "10:00:00",
    session_members: [{
      session_detail_code: "EXTEST-S1-M1",
      label: "Jalur 1",
      member_name: "Member A",
      available_quota: 2,
    }],
  }] });

  assert.equal(stocks["EXTEST-S1-M1"].quota, 2);
  assert.equal(stocks["EXTEST-S1-M1"].member, "Member A");
});

test("controls monitoring with an expiry and one warning", () => {
  const now = Date.parse("2026-09-21T10:00:00.000Z");
  const started = handleCommand("/on 3h", null, now);
  assert.equal(started.state.activeUntil, "2026-09-21T13:00:00.000Z");
  assert.equal(isActive(started.state, now), true);
  assert.equal(timerAction(started.state, now + 149 * 60_000).message, undefined);

  const warning = timerAction(started.state, now + 150 * 60_000);
  assert.match(warning.message, /30 menit/);
  assert.equal(timerAction(warning.state, now + 151 * 60_000).message, undefined);

  const expired = timerAction(warning.state, now + 180 * 60_000);
  assert.match(expired.message, /otomatis OFF/);
  assert.equal(isActive(expired.state, now + 180 * 60_000), false);
});

test("limits sessions and extensions to twelve remaining hours", () => {
  const now = Date.parse("2026-09-21T10:00:00.000Z");
  assert.match(handleCommand("/on 13h", null, now).reply, /1-12 jam/);
  const started = handleCommand("/on 11h", null, now);
  assert.match(handleCommand("/extend 2h", started.state, now).reply, /tidak boleh melebihi/);
  assert.equal(handleCommand("/off", started.state, now).state.activeUntil, null);
});

test("summarizes stock totals by event and product kind", () => {
  const snapshot = {
    checkedAt: "2026-09-21T10:00:00.000Z",
    events: ["MNG", "TS", "VC"],
    errors: [],
    items: {
      a: { ...event, eventCode: "MNG", eventTitle: "Festival MnG", category: "PHOTOCARD", date: "2026-10-24", session: "Sesi 1", startTime: "10:00", lane: "Jalur 1", member: "Member A", quota: 2 },
      b: { ...event, eventCode: "MNG", eventTitle: "Festival MnG", category: "PHOTOCARD", date: "2026-10-24", session: "Sesi 2", startTime: "13:00", lane: "Jalur 2", member: "Member A", quota: 3 },
      c: { ...event, eventCode: "TS", eventTitle: "Festival 2Shot", category: "TWO_SHOT", member: "Member B", quota: 7 },
      d: { ...event, eventCode: "VC", eventTitle: "Video Call", category: "DIGITAL_PHOTOBOOK", member: "Member C", quota: 9 },
    },
  };
  const summary = formatStockSummary(snapshot, "mng", Date.parse("2026-09-21T10:10:00.000Z"));
  assert.match(summary, /Festival MnG/);
  assert.match(summary, /5 tersisa · 2 slot/);
  assert.doesNotMatch(summary, /Festival 2Shot/);
  assert.doesNotMatch(summary, /belum live/);
  const members = formatEventMemberSummary(snapshot, "MNG", Date.parse("2026-09-21T10:10:00.000Z"));
  assert.match(members, /24 Okt 2026 · Sesi 1 \(10:00 WIB\)/);
  assert.match(members, /Jalur 1 · Member A — 2 tersisa/);
  assert.match(members, /Sesi 2 \(13:00 WIB\)/);
  assert.match(members, /Jalur 2 · Member A — 3 tersisa/);
  assert.doesNotMatch(members, /5 tersisa/);
  assert.doesNotMatch(members, /Festival 2Shot/);
});

test("splits long Telegram details without dropping lines", () => {
  const message = ["header", "first row", "second row"].join("\n");
  assert.deepEqual(splitTelegramText(message, 16), ["header\nfirst row", "second row"]);
});

test("builds and formats an authenticated ingest snapshot", () => {
  const snapshot = snapshotFromIngest({ results: [{
    event,
    bonus: { data: [{ label: "Sesi 1", date: "2026-09-21", start_time: "10:00:00", session_members: [{
      session_detail_code: "slot", label: "Jalur 1", member_name: "Member A", available_quota: 4,
    }] }] },
  }] }, new Set(["PHOTOCARD"]), "2026-09-21T10:00:00.000Z");

  assert.equal(snapshot.items.slot.quota, 4);
  assert.match(formatRestockSummary([snapshot.items.slot]), /Sesi 1 \(10:00 WIB\)/);
  assert.throws(() => snapshotFromIngest({ results: [{ event, bonus: {} }] }, new Set(["PHOTOCARD"]), "now"));
});

test("poller selects recent and already tracked events only", () => {
  const payload = { data: { data: [
    { code: "RECENT", title: "Recent", category: "PHOTOCARD", valid_date_from: "2026-09-10T00:00:00Z" },
    { code: "TRACKED", title: "Tracked", category: "TWO_SHOT", valid_date_from: "2025-01-01T00:00:00Z" },
    { code: "OLD", title: "Old", category: "DIGITAL_PHOTOBOOK", valid_date_from: "2025-01-01T00:00:00Z" },
    { code: "OTHER", title: "Other", category: "MERCH", valid_date_from: "2026-09-20T00:00:00Z" },
  ] } };
  assert.deepEqual(selectEvents(payload, ["TRACKED"], Date.parse("2026-09-21T00:00:00Z")).map((item) => item.code), ["RECENT", "TRACKED"]);
});
