// Snippet building and scoring (ported from reference utils.ts)

export interface Snippet {
  start: number;
  end: number;
  score: number;
}

export function buildSnippets(
  lineScores: number[],
  windowSize: number = 7
): Snippet[] {
  const snippets: Snippet[] = [];
  const halfWindow = Math.floor(windowSize / 2);
  const totalLines = lineScores.length;

  for (let lineNum = 0; lineNum < totalLines; lineNum++) {
    if (lineScores[lineNum] <= 0) continue;

    const start = Math.max(0, lineNum - halfWindow);
    const end = Math.min(totalLines, lineNum + halfWindow + 1);

    let totalScore = 0;
    for (let i = start; i < end; i++) {
      totalScore += lineScores[i];
    }

    snippets.push({ start, end, score: totalScore });
  }

  return snippets;
}

export function hasMajorityOverlap(
  candidateStart: number,
  candidateEnd: number,
  selectedStart: number,
  selectedEnd: number
): boolean {
  const overlapStart = Math.max(candidateStart, selectedStart);
  const overlapEnd = Math.min(candidateEnd, selectedEnd);
  const overlapCount = Math.max(0, overlapEnd - overlapStart);
  const candidateSize = candidateEnd - candidateStart;
  return overlapCount > candidateSize / 2;
}

export function selectTopSnippets(
  snippets: Snippet[],
  maxSnippets: number = 5
): Array<{ start: number; end: number }> {
  const sorted = [...snippets]
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected: Array<{ start: number; end: number }> = [];

  for (const snippet of sorted) {
    if (selected.length >= maxSnippets) break;

    const { start, end } = snippet;
    let hasOverlap = false;
    for (const sel of selected) {
      if (hasMajorityOverlap(start, end, sel.start, sel.end)) {
        hasOverlap = true;
        break;
      }
    }

    if (!hasOverlap) {
      selected.push({ start, end });
    }
  }

  return selected;
}

export function formatSnippet(
  lines: string[],
  start: number,
  end: number
): string {
  return lines
    .slice(start, end)
    .map((l, idx) => `${start + idx}: ${l}`)
    .join("\n");
}

export function formatWithLineNumbers(
  content: string,
  startLine?: number,
  endLine?: number
): string {
  const lines = content.split("\n");

  const start = startLine !== undefined ? Math.max(0, startLine) : 0;
  const end =
    endLine !== undefined ? Math.min(lines.length - 1, endLine) : lines.length - 1;

  if (start > end || start >= lines.length) return "";

  return lines
    .slice(start, end + 1)
    .map((line, idx) => `${start + idx}: ${line}`)
    .join("\n");
}

export function buildFileTree(files: string[], prefix: string): string {
  const tree: Map<string, string[]> = new Map();

  for (const file of files) {
    const relative = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    const parts = relative.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    const filename = parts[parts.length - 1];

    if (!tree.has(dir)) tree.set(dir, []);
    tree.get(dir)!.push(filename);
  }

  const output: string[] = [];
  const sortedDirs = [...tree.keys()].sort();

  for (const dir of sortedDirs) {
    if (dir !== ".") output.push(`${dir}/`);
    const filesInDir = tree.get(dir)!.sort();
    for (const f of filesInDir) {
      output.push(dir === "." ? f : `  ${f}`);
    }
  }

  return output.join("\n");
}

export function getLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    rs: "rust",
    ts: "typescript",
    js: "javascript",
    py: "python",
    go: "go",
    sol: "solidity",
    toml: "toml",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
  };
  return map[ext] ?? ext;
}

export function isValidPath(path: string): boolean {
  if (path.includes("..")) return false;
  if (path.startsWith("/")) return false;
  return true;
}

export function buildFTSQuery(
  query: string,
  mode: "substring" | "word"
): { ftsQuery: string | null; snippetMatcher: (line: string) => number } {
  const trimmed = query.trim();

  if (mode === "substring") {
    if (trimmed.length < 3) {
      return { ftsQuery: null, snippetMatcher: () => 0 };
    }
    const escaped = trimmed.replace(/"/g, '""');
    const queryLower = trimmed.toLowerCase();
    return {
      ftsQuery: `"${escaped}"`,
      snippetMatcher: (line) => {
        let count = 0;
        let idx = 0;
        while ((idx = line.indexOf(queryLower, idx)) !== -1) {
          count++;
          idx += queryLower.length;
        }
        return count;
      },
    };
  } else {
    const escaped = trimmed.replace(/["()*:^-]/g, " ").trim();
    const words = escaped.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      return { ftsQuery: null, snippetMatcher: () => 0 };
    }
    const ftsQuery = words.map((w) => `${w}*`).join(" ");
    const wordsLower = words.map((w) => w.toLowerCase());
    return {
      ftsQuery,
      snippetMatcher: (line) => {
        let count = 0;
        for (const word of wordsLower) {
          let idx = 0;
          while ((idx = line.indexOf(word, idx)) !== -1) {
            count++;
            idx += word.length;
          }
        }
        return count;
      },
    };
  }
}
