import { initDb, indexRepo, getIndexedRepos } from "./database.js";
import { getTree, fetchRawFile } from "../github/index.js";

const INDEXABLE_EXTS = new Set([
  "rs", "ts", "js", "go", "py", "sol", "toml", "md", "json", "yaml", "yml", "lock",
]);

const MAX_FILE_SIZE = 500_000; // 500KB
const BATCH_SIZE = 20;

function isIndexable(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return INDEXABLE_EXTS.has(ext);
}

async function fetchBatch(
  repo: string,
  paths: string[]
): Promise<Array<{ path: string; content: string }>> {
  const results = await Promise.allSettled(
    paths.map(async (p) => {
      const content = await fetchRawFile(repo, p);
      if (content === null) return null;
      return { path: p, content };
    })
  );
  const files: Array<{ path: string; content: string }> = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      files.push(r.value);
    }
  }
  return files;
}

export interface IndexResult {
  summary: string[];
  errors: string[];
  elapsedSeconds: number;
}

export async function indexRepos(
  repos: string[],
  opts?: { force?: boolean; onProgress?: (msg: string) => void }
): Promise<IndexResult> {
  const start = Date.now();
  const force = opts?.force ?? false;
  const log = opts?.onProgress ?? (() => {});

  initDb();

  const alreadyIndexed = new Set(
    getIndexedRepos().map((r) => r.repo)
  );

  const summary: string[] = [];
  const errors: string[] = [];

  for (const repo of repos) {
    if (!force && alreadyIndexed.has(repo)) {
      const msg = `${repo}: skipped (already indexed)`;
      summary.push(msg);
      log(msg);
      continue;
    }

    try {
      log(`${repo}: fetching tree...`);
      const tree = await getTree(repo);
      const indexable = tree.filter(
        (e) =>
          isIndexable(e.path) &&
          (e.size === undefined || e.size <= MAX_FILE_SIZE)
      );

      log(`${repo}: fetching ${indexable.length} files...`);
      const allFiles: Array<{ path: string; content: string }> = [];

      for (let i = 0; i < indexable.length; i += BATCH_SIZE) {
        const batch = indexable.slice(i, i + BATCH_SIZE);
        const fetched = await fetchBatch(
          repo,
          batch.map((e) => e.path)
        );
        allFiles.push(...fetched);
        log(`${repo}: ${allFiles.length}/${indexable.length} files fetched`);
      }

      indexRepo(repo, allFiles);
      const msg = `${repo}: indexed ${allFiles.length} files`;
      summary.push(msg);
      log(msg);
    } catch (e) {
      const msg = `${repo}: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      log(`ERROR: ${msg}`);
    }
  }

  const elapsedSeconds = (Date.now() - start) / 1000;
  return { summary, errors, elapsedSeconds };
}
