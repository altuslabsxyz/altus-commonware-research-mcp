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

export function generateBigrams(keywords: string[]): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < keywords.length - 1; i++) {
    bigrams.push(`${keywords[i]} ${keywords[i + 1]}`);
  }
  return bigrams;
}

export function computeIdf(
  paragraphs: string[],
  keywords: string[]
): Map<string, number> {
  const total = paragraphs.length;
  const idf = new Map<string, number>();

  for (const kw of keywords) {
    let count = 0;
    for (const para of paragraphs) {
      if (para.toLowerCase().includes(kw)) count++;
    }
    idf.set(kw, Math.log(total / Math.max(count, 1)) + 1);
  }

  return idf;
}

export function scoreParagraph(
  text: string,
  keywords: string[],
  bigrams: string[],
  idfWeights: Map<string, number>,
  sectionHeader?: string
): number {
  if (keywords.length === 0 && bigrams.length === 0) return 1;
  const lower = text.toLowerCase();
  let score = 0;

  // Unigram matches weighted by IDF
  for (const kw of keywords) {
    if (lower.includes(kw)) {
      score += idfWeights.get(kw) ?? 1;
    }
  }

  // Bigram matches at 3x weight
  for (const bg of bigrams) {
    if (lower.includes(bg)) {
      score += 3;
    }
  }

  // Header keyword matches at 2x IDF weight
  if (sectionHeader) {
    const headerLower = sectionHeader.toLowerCase();
    for (const kw of keywords) {
      if (headerLower.includes(kw)) {
        score += (idfWeights.get(kw) ?? 1) * 2;
      }
    }
  }

  return score;
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

const HEADER_REGEX = /^#{1,6}\s+(.+)/;

export function extractAllRelevantParagraphs(
  pages: PageInfo[],
  query: string,
  extraKeywords?: { unigrams: string[]; bigrams: string[] }
): ScoredParagraph[] {
  // Merge base keywords + extra keywords (deduplicated)
  const baseKeywords = tokenizeQuery(query);
  const baseBigrams = generateBigrams(baseKeywords);

  const allUnigrams = [...new Set([...baseKeywords, ...(extraKeywords?.unigrams ?? [])])];
  const allBigrams = [...new Set([...baseBigrams, ...(extraKeywords?.bigrams ?? [])])];

  // Pass 1: Split all pages into paragraphs, track current markdown header
  const corpus: { text: string; pageId: string; pageTitle: string; sectionHeader?: string }[] = [];

  for (const page of pages) {
    if (!page.content || page.content.trim().length === 0) continue;

    const paragraphs = page.content.split(/\n{2,}|\n(?=#\s)/);
    let currentHeader: string | undefined;

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length < 20) continue;

      // Detect markdown headers
      const headerMatch = trimmed.match(HEADER_REGEX);
      if (headerMatch) {
        currentHeader = headerMatch[1].trim();
      }

      corpus.push({
        text: trimmed,
        pageId: page.id,
        pageTitle: page.title.substring(0, 100),
        sectionHeader: currentHeader,
      });
    }
  }

  // Pass 2: Compute IDF across full paragraph corpus
  const corpusTexts = corpus.map(c => c.text);
  const idfWeights = computeIdf(corpusTexts, allUnigrams);

  // Pass 3: Score each paragraph with IDF + bigrams + header boost
  const allParagraphs: ScoredParagraph[] = [];

  for (const item of corpus) {
    const score = scoreParagraph(item.text, allUnigrams, allBigrams, idfWeights, item.sectionHeader);
    if (score > 0) {
      allParagraphs.push({
        text: item.text,
        score,
        pageId: item.pageId,
        pageTitle: item.pageTitle,
        sectionHeader: item.sectionHeader,
      });
    }
  }

  return allParagraphs;
}

export function selectRelevantParagraphs(
  pages: PageInfo[],
  query: string,
  maxCount?: number,
  extraKeywords?: { unigrams: string[]; bigrams: string[] }
): ScoredParagraph[] {
  const hardCap = maxCount ?? 15;
  const minCount = 3;

  const allParagraphs = extractAllRelevantParagraphs(pages, query, extraKeywords);

  // Sort by relevance score (descending)
  allParagraphs.sort((a, b) => b.score - a.score);

  if (allParagraphs.length === 0) return [];

  // Adaptive threshold: 40% of top score
  const topScore = allParagraphs[0].score;
  const threshold = topScore * 0.4;

  // Deduplicate and collect paragraphs with adaptive cutoff
  const selectedTexts: string[] = [];
  const selected: ScoredParagraph[] = [];

  for (const para of allParagraphs) {
    if (selected.length >= hardCap) break;

    // Stop when score drops below threshold AND we have minimum count
    if (para.score < threshold && selected.length >= minCount) break;

    if (isDuplicate(para.text, selectedTexts)) continue;

    selected.push(para);
    selectedTexts.push(para.text);
  }

  return selected;
}

export function generateSummary(
  query: string,
  pages: PageInfo[],
  preselected?: ScoredParagraph[],
  expandedKeywords?: { unigrams: string[]; bigrams: string[] }
): string {
  const sections: string[] = [];
  const keywords = tokenizeQuery(query);

  sections.push(`# Research: ${query}\n`);

  // Display expanded keywords/phrases in the summary header
  const allTerms = [...keywords];
  if (expandedKeywords) {
    for (const u of expandedKeywords.unigrams) {
      if (!allTerms.includes(u)) allTerms.push(u);
    }
  }
  const phrases = expandedKeywords?.bigrams ?? [];

  let headerLine = `> Explored ${pages.length} pages | Keywords: ${allTerms.join(", ")}`;
  if (phrases.length > 0) {
    headerLine += ` | Phrases: ${phrases.join(", ")}`;
  }
  sections.push(headerLine + "\n");

  const selected = preselected ?? selectRelevantParagraphs(pages, query);

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

    let lastHeader: string | undefined;
    for (const para of paras) {
      // Render section header before paragraphs (deduplicate consecutive same-header)
      if (para.sectionHeader && para.sectionHeader !== lastHeader) {
        sections.push(`### ${para.sectionHeader}\n`);
        lastHeader = para.sectionHeader;
      }
      sections.push(para.text);
      sections.push(""); // Empty line between paragraphs
    }
    sections.push("\n---\n");
  }

  return sections.join("\n");
}
