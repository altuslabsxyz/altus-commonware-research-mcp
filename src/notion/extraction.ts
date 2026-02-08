// ─────────────────────────────────────────────────────────────────────────────
// Notion Content Extraction
// ─────────────────────────────────────────────────────────────────────────────

export function extractText(content: unknown): string {
  if (!content) return "";

  if (typeof content === "string") {
    try {
      return extractText(JSON.parse(content));
    } catch {
      return content;
    }
  }

  if (Array.isArray(content)) {
    return content.map(extractText).join(" ");
  }

  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") return obj.text;
    if (obj.plain_text) return String(obj.plain_text);
    for (const key of ["title", "rich_text", "text"]) {
      if (obj[key]) return extractText(obj[key]);
    }
    return Object.values(obj).map(extractText).join(" ");
  }

  return String(content);
}

export function extractNotionText(content: unknown): string {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      return parsed.text ?? content;
    } catch {
      return content;
    }
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        if (obj.type === "text" && typeof obj.text === "string") {
          try {
            const parsed = JSON.parse(obj.text);
            return parsed.text ?? obj.text;
          } catch {
            return obj.text;
          }
        }
      }
    }
  }

  if (typeof content === "object" && content !== null) {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }

  return "";
}

export function extractPageId(url: string): string | null {
  const match = url.match(/([a-f0-9]{32})/);
  return match ? match[1] : null;
}

export function extractPagesFromText(text: string): { id: string; title: string }[] {
  const pages: { id: string; title: string }[] = [];
  const pageRegex = /<page\s+url="\{\{([^}]+)\}\}"[^>]*>([^<]+)<\/page>/g;

  let match;
  while ((match = pageRegex.exec(text)) !== null) {
    const pageId = extractPageId(match[1]);
    const title = match[2].trim();
    if (pageId && title) pages.push({ id: pageId, title });
  }

  return pages;
}

export function filterExcludedPages(pages: { id: string; title: string }[]): { id: string; title: string }[] {
  const excludePatterns = [/review/i, /wip/i];
  return pages.filter(p => !excludePatterns.some(pattern => pattern.test(p.title)));
}

export function extractResearchSectionPages(content: unknown): { id: string; title: string }[] {
  const text = extractNotionText(content);
  const researchMatch = text.match(/## Research\n([\s\S]*?)(?=\n## |$)/);
  const pages = researchMatch ? extractPagesFromText(researchMatch[1]) : [];
  return filterExcludedPages(pages);
}

export function extractAllChildPages(content: unknown): { id: string; title: string }[] {
  return filterExcludedPages(extractPagesFromText(extractNotionText(content)));
}
