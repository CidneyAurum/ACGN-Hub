/** Convert chapter markup to plain text without executing or retaining active content. */
export function novelHtmlToText(value: string): string {
  return decodeNovelEntities(value
    .replace(/<!--[^]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[^>]*>[^]*?<\/\1\s*>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decode after removing markup so escaped prose such as &lt;3 is preserved. */
export function decodeNovelEntities(value: string): string {
  const named: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));/gi, (entity: string, numeric?: string, name?: string) => {
    if (name) return named[name.toLowerCase()] ?? entity;
    const code = numeric?.[0].toLowerCase() === "x" ? parseInt(numeric.slice(1), 16) : Number(numeric);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : entity;
  });
}
