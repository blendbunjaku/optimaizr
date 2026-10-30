// Small line icons, drawn on a 16px grid in currentColor so they take the theme.

const svg = (body: string, cls = "") =>
  `<svg class="ico ${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  logo: `<svg class="logo" viewBox="0 0 64 64" width="22" height="22" aria-hidden="true"><rect width="64" height="64" rx="14" class="logo-tile"/><path d="M15 21 L26 32 L15 43" fill="none" class="logo-chevron" stroke-width="5" stroke-linecap="square"/><rect x="30" y="39" width="19" height="5" class="logo-cursor"/></svg>`,
  refresh: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>'),
  shield: svg(
    '<path d="M8 1.75 2.75 3.5v4c0 3.2 2.2 5.6 5.25 6.75 3.05-1.15 5.25-3.55 5.25-6.75v-4L8 1.75Z"/>',
  ),
  shieldCheck: svg(
    '<path d="M8 1.75 2.75 3.5v4c0 3.2 2.2 5.6 5.25 6.75 3.05-1.15 5.25-3.55 5.25-6.75v-4L8 1.75Z"/><path d="m5.75 8 1.6 1.6 3-3.2"/>',
  ),
  bolt: svg('<path d="M8.75 1.5 3.5 9h4l-.75 5.5L12.5 7h-4l.25-5.5Z"/>'),
  check: svg('<path d="m3.5 8.5 3 3 6-7"/>'),
  undo: svg('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.75 6H10a3.5 3.5 0 0 1 0 7H7"/>'),
  chevron: svg('<path d="m6 3.5 4.5 4.5L6 12.5"/>', "chev"),
  lock: svg(
    '<rect x="3.25" y="7" width="9.5" height="7" rx="1.5"/><path d="M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2"/>',
  ),
  layers: svg('<path d="m8 2 6 3.25-6 3.25-6-3.25L8 2Z"/><path d="m2 8.25 6 3.25 6-3.25"/>'),
  gauge: svg('<path d="M2.5 11.5a5.5 5.5 0 1 1 11 0"/><path d="m8 11.5 2.75-3.25"/>'),
  spark: svg(
    '<path d="M8 1.75v3M8 11.25v3M1.75 8h3M11.25 8h3M3.6 3.6l2 2M10.4 10.4l2 2M12.4 3.6l-2 2M5.6 10.4l-2 2"/>',
  ),
  report: svg('<path d="M2.5 13.5h11"/><path d="M4.5 11V7.5M8 11V4M11.5 11V8.75"/>'),
  pause: svg(
    '<rect x="4" y="3" width="2.5" height="10" rx=".75"/><rect x="9.5" y="3" width="2.5" height="10" rx=".75"/>',
  ),
  snow: svg(
    '<path d="M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5"/><path d="m6 2.75 2 1.5 2-1.5M6 13.25l2-1.5 2 1.5"/>',
  ),
  gear: svg(
    '<circle cx="8" cy="8" r="2.25"/><path d="M8 1.5v1.75M8 12.75v1.75M14.5 8h-1.75M3.25 8H1.5M12.6 3.4l-1.25 1.25M4.65 11.35 3.4 12.6M12.6 12.6l-1.25-1.25M4.65 4.65 3.4 3.4"/>',
  ),
  star: svg(
    '<path d="m8 1.75 1.9 3.9 4.3.6-3.1 3 .75 4.25L8 11.5l-3.85 2 .75-4.25-3.1-3 4.3-.6L8 1.75Z"/>',
  ),
};
