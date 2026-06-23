/** Slugify an arbitrary label into a filesystem-safe segment. */
export function slug(input: string, maxLen = 40): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, maxLen).replace(/-+$/g, "");
}

/** A host like "www.example.com" -> "example-com" (drops a leading www). */
export function hostSlug(host: string): string {
  return slug(host.replace(/^www\./, ""));
}

/** Local timestamp "YYYY-MM-DD_HHMMSS". */
export function timestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export interface NameParts {
  startedAt: Date;
  primaryHost?: string;
  label?: string;
  checkpoints?: string[];
  titles?: string[];
}

/**
 * Build a descriptive recording directory name, e.g.
 *   2026-06-22_143052__example-com__login__dashboard
 * Order: timestamp · host · label/checkpoints · last page title.
 */
export function deriveRecordingName(parts: NameParts): string {
  const segs: string[] = [timestamp(parts.startedAt)];
  if (parts.primaryHost) {
    const h = hostSlug(parts.primaryHost);
    if (h) segs.push(h);
  }
  const mids: string[] = [];
  if (parts.label) mids.push(slug(parts.label));
  for (const c of parts.checkpoints ?? []) {
    const s = slug(c);
    if (s) mids.push(s);
  }
  const lastTitle = (parts.titles ?? []).filter(Boolean).pop();
  if (lastTitle) mids.push(slug(lastTitle));

  // De-duplicate consecutive / repeated segments to avoid "login__login".
  const seen = new Set<string>();
  for (const m of mids) {
    if (m && !seen.has(m)) {
      seen.add(m);
      segs.push(m);
    }
  }
  return segs.join("__");
}
