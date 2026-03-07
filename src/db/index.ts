export {
  initDb,
  getDb,
  closeDb,
  isDbInitialized,
  indexRepo,
  clearRepo,
  getIndexedRepos,
  searchFTS,
  getFile,
  getFileList,
  type IndexedRepo,
  type FTSResult,
} from "./database.js";

export {
  buildSnippets,
  selectTopSnippets,
  formatSnippet,
  formatWithLineNumbers,
  buildFileTree,
  getLanguage,
  isValidPath,
  buildFTSQuery,
  type Snippet,
} from "./snippets.js";

export { indexRepos, type IndexResult } from "./indexer.js";
