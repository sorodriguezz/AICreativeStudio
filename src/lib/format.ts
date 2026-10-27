/** SQLite guarda `datetime('now')` en UTC sin zona: lo interpretamos como UTC. */
export function parseDate(s: string): Date {
  return new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

export function relativeTime(s: string): string {
  const diff = (parseDate(s).getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "recién";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return parseDate(s).toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

export function aspectRatio(aspect?: string | null, width?: number | null, height?: number | null): number {
  if (width && height) return width / height;
  const [w, h] = (aspect ?? "1:1").split(":").map(Number);
  return w && h ? w / h : 1;
}

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? "⌘" : "Ctrl";
