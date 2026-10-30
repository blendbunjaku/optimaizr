// Number formatting shared by the host and the webviews, so the status bar,
// a notification and the sidebar never print the same figure two ways.

export function money(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  const a = Math.abs(n);
  if (a >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (a >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

export function percent(share: number): string {
  const p = share * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

export function multiple(m: number): string {
  return `${m >= 10 ? Math.round(m) : m.toFixed(1)}x`;
}

/** 4:07 under an hour, 1h 12m past it. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A short "how long it worked": 48s, 2m 14s, 1h 3m. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function ago(iso: string | number, now: number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const m = Math.round((now - t) / 60_000);
  if (!Number.isFinite(m) || m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function day(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

/** The last folder of a path, for a conversation without a title. */
export function folder(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
