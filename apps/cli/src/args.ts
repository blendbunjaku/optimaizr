export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      // Split on the first "=" only, so `--project=a=b` keeps its value whole.
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const next = argv[i + 1];
      if (eq !== -1) flags[key] = a.slice(eq + 1);
      else if (next && !next.startsWith("-")) flags[key] = argv[++i]!;
      else flags[key] = true;
    } else positional.push(a);
  }
  return { command: positional[0] ?? "profile", positional: positional.slice(1), flags };
}

export function num(v: string | boolean | undefined, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
