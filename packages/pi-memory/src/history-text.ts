/** Preserve both context and conclusions without pretending an excerpt is complete. */
export function historyExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = '\n[history middle omitted]\n';
  if (maxChars <= marker.length + 2) return text.slice(0, Math.max(0, maxChars));
  const head = Math.floor((maxChars - marker.length) / 2);
  return `${text.slice(0, head)}${marker}${text.slice(-(maxChars - marker.length - head))}`;
}
