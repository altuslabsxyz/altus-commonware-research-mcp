#!/usr/bin/env node
import { REFERENCE_REPOS } from "../config.js";
import { indexRepos } from "../db/indexer.js";
import { closeDb } from "../db/database.js";

const args = process.argv.slice(2);
const force = args.includes("--force");

const repos = args.filter((a) => !a.startsWith("--"));
const targetRepos = repos.length > 0 ? repos : [...REFERENCE_REPOS];

if (targetRepos.length === 0) {
  console.error("No repos to index. Set REFERENCE_REPOS in .env or pass repos as arguments.");
  process.exit(1);
}

console.log(`Indexing ${targetRepos.length} repo(s)${force ? " (force)" : ""}...`);

const result = await indexRepos(targetRepos, {
  force,
  onProgress: (msg) => console.log(`  ${msg}`),
});

console.log(`\nDone in ${result.elapsedSeconds.toFixed(1)}s`);
for (const line of result.summary) {
  console.log(`  ${line}`);
}
if (result.errors.length > 0) {
  console.error("\nErrors:");
  for (const line of result.errors) {
    console.error(`  ${line}`);
  }
}

closeDb();
process.exit(result.errors.length > 0 ? 1 : 0);
