export type MonitorState = {
  activeUntil: string | null;
  warningSent: boolean;
};

export type CommandResult = {
  state?: MonitorState;
  reply: string;
};

const DEFAULT_HOURS = 3;
const MAX_HOURS = 12;

export function isActive(state: MonitorState | null, nowMs = Date.now()): boolean {
  return Boolean(state?.activeUntil && Date.parse(state.activeUntil) > nowMs);
}

function formatWib(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso)) + " WIB";
}

function remainingMinutes(state: MonitorState, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(state.activeUntil ?? "") - nowMs) / 60_000));
}

function duration(text: string | undefined): number | null {
  if (!text) return DEFAULT_HOURS;
  const match = /^(\d{1,2})(?:h|j|jam)?$/i.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  return hours >= 1 && hours <= MAX_HOURS ? hours : null;
}

export function handleCommand(input: string, current: MonitorState | null, nowMs = Date.now()): CommandResult {
  const [rawCommand = "", rawDuration] = input.trim().split(/\s+/, 2);
  const command = rawCommand.toLowerCase().replace(/@[^\s]+$/, "");

  if (command === "/on") {
    const hours = duration(rawDuration);
    if (hours === null) return { reply: "Format: /on 3h (1-12 jam)." };
    const state = { activeUntil: new Date(nowMs + hours * 3_600_000).toISOString(), warningSent: false };
    return { state, reply: `✅ Pemantauan aktif sampai ${formatWib(state.activeUntil)}.\nPengingat dikirim 30 menit sebelum berhenti.` };
  }

  if (command === "/off") {
    return { state: { activeUntil: null, warningSent: false }, reply: "⏹️ Pemantauan sudah dihentikan." };
  }

  if (command === "/status") {
    if (!current || !isActive(current, nowMs)) return { reply: "⏹️ Pemantauan sedang OFF. Gunakan /on 3h untuk mengaktifkan." };
    return { reply: `✅ Pemantauan aktif sampai ${formatWib(current.activeUntil!)} (${remainingMinutes(current, nowMs)} menit lagi).` };
  }

  if (command === "/extend") {
    const hours = duration(rawDuration);
    if (hours === null) return { reply: "Format: /extend 2h (1-12 jam)." };
    if (!current || !isActive(current, nowMs)) return { reply: "Pemantauan sedang OFF. Gunakan /on 3h terlebih dahulu." };
    const activeUntil = Date.parse(current.activeUntil!) + hours * 3_600_000;
    if (activeUntil > nowMs + MAX_HOURS * 3_600_000) return { reply: "Durasi tersisa tidak boleh melebihi 12 jam." };
    const state = { activeUntil: new Date(activeUntil).toISOString(), warningSent: false };
    return { state, reply: `➕ Waktu ditambah. Aktif sampai ${formatWib(state.activeUntil)}.` };
  }

  return { reply: "Perintah tersedia:\n/on 3h — aktifkan\n/off — hentikan\n/status — cek status\n/extend 2h — tambah waktu\n/stock — sisa stok per event" };
}

export function timerAction(state: MonitorState | null, nowMs = Date.now()): { state?: MonitorState; message?: string } {
  if (!state?.activeUntil) return {};
  const minutes = remainingMinutes(state, nowMs);
  if (minutes === 0) {
    return { state: { activeUntil: null, warningSent: false }, message: "⏹️ Waktu pemantauan habis. Bot otomatis OFF." };
  }
  if (minutes <= 30 && !state.warningSent) {
    return {
      state: { ...state, warningSent: true },
      message: `⚠️ Pemantauan akan berhenti otomatis ${minutes} menit lagi, pukul ${formatWib(state.activeUntil)}.`,
    };
  }
  return {};
}
