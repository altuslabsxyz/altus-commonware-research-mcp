import type { PageInfo, ScoredParagraph } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Summarization Layer
// ─────────────────────────────────────────────────────────────────────────────

export function flattenPages(pages: PageInfo[]): PageInfo[] {
  const flat: PageInfo[] = [];
  function traverse(page: PageInfo) {
    flat.push({ id: page.id, title: page.title, content: page.content });
    page.children?.forEach(traverse);
  }
  pages.forEach(traverse);
  return flat;
}

export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 3)
    .map(w => w.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
}

export function scoreParagraph(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 1;
  const lower = text.toLowerCase();
  return keywords.filter(kw => lower.includes(kw)).length;
}

export function isDuplicate(text: string, existing: string[]): boolean {
  // Check if text is too similar to existing paragraphs
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.length < 50) return false; // Short paragraphs are fine

  for (const ex of existing) {
    const exNorm = ex.toLowerCase().replace(/\s+/g, " ").trim();
    // If 80% of the shorter text is contained in the longer, it's a duplicate
    const shorter = normalized.length < exNorm.length ? normalized : exNorm;
    const longer = normalized.length < exNorm.length ? exNorm : normalized;
    if (longer.includes(shorter.substring(0, Math.floor(shorter.length * 0.8)))) {
      return true;
    }
  }
  return false;
}

export function extractAllRelevantParagraphs(pages: PageInfo[], query: string): ScoredParagraph[] {
  const keywords = tokenizeQuery(query);
  const allParagraphs: ScoredParagraph[] = [];

  for (const page of pages) {
    if (!page.content || page.content.trim().length === 0) continue;

    // Split content into paragraphs
    const paragraphs = page.content.split(/\n{2,}|\n(?=#\s)/);

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length < 20) continue; // Skip very short paragraphs

      const score = scoreParagraph(trimmed, keywords);
      if (score > 0) {
        allParagraphs.push({
          text: trimmed,
          score,
          pageId: page.id,
          pageTitle: page.title.substring(0, 100),
        });
      }
    }
  }

  return allParagraphs;
}

export function generateSummary(query: string, pages: PageInfo[]): string {
  const sections: string[] = [];
  const keywords = tokenizeQuery(query);

  sections.push(`# Research: ${query}\n`);
  sections.push(`> Explored ${pages.length} pages | Keywords: ${keywords.join(", ")}\n`);

  // Collect ALL paragraphs from ALL pages, score them globally
  const allParagraphs = extractAllRelevantParagraphs(pages, query);

  // Sort by relevance score (descending)
  allParagraphs.sort((a, b) => b.score - a.score);

  // Deduplicate and collect top paragraphs (max 10 total)
  const selectedTexts: string[] = [];
  const selected: ScoredParagraph[] = [];

  for (const para of allParagraphs) {
    if (selected.length >= 10) break;
    if (isDuplicate(para.text, selectedTexts)) continue;

    selected.push(para);
    selectedTexts.push(para.text);
  }

  if (selected.length === 0) {
    sections.push("*No content directly related to the query was found.*");
    return sections.join("\n");
  }

  // Group selected paragraphs by page for organized output
  const byPage = new Map<string, ScoredParagraph[]>();
  for (const para of selected) {
    const key = para.pageId;
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key)!.push(para);
  }

  // Output: show contribution from each page
  sections.push(`> Found ${selected.length} relevant paragraphs from ${byPage.size} pages\n`);

  for (const [pageId, paras] of byPage) {
    const title = paras[0].pageTitle;
    sections.push(`## ${title}`);
    sections.push(`*Page ID: ${pageId} | ${paras.length} relevant sections*\n`);

    for (const para of paras) {
      sections.push(para.text);
      sections.push(""); // Empty line between paragraphs
    }
    sections.push("\n---\n");
  }

  return sections.join("\n");
}
