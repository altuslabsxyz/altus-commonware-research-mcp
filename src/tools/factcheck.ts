import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  analyzeRepoFlow,
  searchRepos,
  validateRepos,
  type FlowAnalysisResult,
  type SearchMatch,
} from "../github/index.js";
import { REFERENCE_REPOS } from "../config.js";
import { askNotebookLm } from "../notebooklm/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Claim extraction and retrieval planning
// ─────────────────────────────────────────────────────────────────────────────

interface Claim {
  id: number;
  text: string;
  keywords: string[];
}

type ClaimBucket = "fact" | "flow" | "component";

interface ValidationItem extends Claim {
  bucket: ClaimBucket;
  requiredStaticEvidence: number;
  requiredFlowEvidence: number;
  selectedRepo: string;
  comparisonGroup?: string;
}

interface ClientValidationItemInput {
  text: string;
  bucket?: string;
  keywords?: string[];
  selected_repo?: string;
  comparison_group?: string;
}

const MAX_CLAIMS = 12;
const MAX_MATCHES_PER_CLAIM = 2;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_SNIPPET_CHARS = 900;
const MAX_FLOW_ITEMS = 12;
const MAX_RESPONSE_BYTES = 14000;
const MAX_CONTRADICTION_SNIPPET_CHARS = 520;
const MAX_CONTRADICTION_ITEMS = 12;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n...(truncated)`;
}

function truncateInline(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

function cleanClaimText(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBucket(bucket: string | undefined): ClaimBucket {
  if (!bucket) return "fact";
  const normalized = bucket.trim().toLowerCase();
  if (normalized === "flow" || normalized === "component" || normalized === "fact") {
    return normalized;
  }

  // Accept common user-facing labels without forcing strict enums.
  if (
    normalized.includes("flow") ||
    normalized.includes("sequence") ||
    normalized.includes("lifecycle") ||
    normalized.includes("call tree") ||
    normalized.includes("logic")
  ) {
    return "flow";
  }

  if (
    normalized.includes("architecture") ||
    normalized.includes("component") ||
    normalized.includes("module") ||
    normalized.includes("diagram") ||
    normalized.includes("topology")
  ) {
    return "component";
  }

  if (
    normalized.includes("data model") ||
    normalized.includes("schema") ||
    normalized.includes("fact")
  ) {
    return "fact";
  }

  return "fact";
}

function normalizeKeywords(keywords: readonly string[] | undefined): string[] {
  if (!keywords?.length) return [];
  const out = keywords
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(out)].slice(0, 8);
}

interface AiPlanItem {
  text?: string;
  selected_repo?: string;
  bucket?: string;
  keywords?: string[];
  comparison_group?: string;
}

interface AiPlanResult {
  items?: AiPlanItem[];
  notes?: string[];
}

function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return raw.slice(first, last + 1).trim();
  }
  return null;
}

function parseAiPlan(raw: string): AiPlanResult | null {
  const candidate = extractJsonObject(raw);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as AiPlanResult;
  } catch {
    return null;
  }
}

function buildAiPlanningPrompt(sourceText: string, candidateRepos: readonly string[]): string {
  return [
    "You are planning fact-check validation items for code verification.",
    "Given the document/claims and the allowed repositories, output ONLY JSON.",
    "Rules:",
    "- Choose concrete technical items to validate (max 12).",
    "- Map each item to exactly one selected_repo from allowed list.",
    "- Provide bucket as one of: fact, flow, component.",
    "- Provide keywords for code retrieval (2-8 concise technical terms).",
    "- Comparative claims MUST be split into separate single-repo items sharing the same comparison_group id.",
    "",
    `Allowed repositories: ${candidateRepos.join(", ")}`,
    "",
    "JSON schema:",
    "{",
    '  "items": [',
    '    {"text":"...", "selected_repo":"...", "bucket":"fact|flow|component", "keywords":["..."], "comparison_group":"optional"}',
    "  ],",
    '  "notes": ["optional planning notes"]',
    "}",
    "",
    "Document/claims to plan:",
    sourceText,
  ].join("\n");
}

async function planValidationItemsWithAi(
  sourceText: string,
  candidateRepos: readonly string[],
): Promise<{ items: ValidationItem[]; notes: string[]; raw: string }> {
  const prompt = buildAiPlanningPrompt(sourceText, candidateRepos);
  const raw = await askNotebookLm(prompt);
  const parsed = parseAiPlan(raw);
  const notes = parsed?.notes?.filter(Boolean) ?? [];
  const inputItems = parsed?.items ?? [];
  const items: ValidationItem[] = [];

  for (const entry of inputItems) {
    if (items.length >= MAX_CLAIMS) break;
    const text = cleanClaimText(entry.text ?? "");
    if (!text) continue;
    const selectedRepo = (entry.selected_repo ?? "").trim();
    if (!selectedRepo || !candidateRepos.includes(selectedRepo)) continue;
    const keywords = normalizeKeywords(entry.keywords);
    if (keywords.length === 0) continue;
    const bucket = normalizeBucket(entry.bucket);
    items.push({
      id: items.length + 1,
      text,
      keywords,
      bucket,
      requiredStaticEvidence: 1,
      requiredFlowEvidence: bucket === "flow" ? 1 : 0,
      selectedRepo,
      comparisonGroup: entry.comparison_group?.trim() || undefined,
    });
  }

  return { items, notes, raw };
}

function normalizeClientValidationItems(
  items: readonly ClientValidationItemInput[],
  targetRepos: readonly string[],
): ValidationItem[] {
  const normalized: ValidationItem[] = [];
  const seen = new Set<string>();

  for (const raw of items) {
    const cleanedText = cleanClaimText(raw.text ?? "");
    if (!cleanedText) continue;
    const key = [
      cleanedText.toLowerCase(),
      (raw.selected_repo ?? "").toLowerCase(),
      (raw.comparison_group ?? "").toLowerCase(),
    ].join("::");
    if (seen.has(key)) continue;
    seen.add(key);

    const inferredBucket = normalizeBucket(raw.bucket);
    const itemKeywords = normalizeKeywords(raw.keywords);

    let selectedRepo = raw.selected_repo?.trim();
    if (
      selectedRepo &&
      (!REFERENCE_REPOS.includes(selectedRepo) || !targetRepos.includes(selectedRepo))
    ) {
      selectedRepo = undefined;
    }
    if (!selectedRepo) {
      selectedRepo = targetRepos[0] ?? REFERENCE_REPOS[0];
    }

    normalized.push({
      id: normalized.length + 1,
      text: cleanedText,
      keywords: itemKeywords,
      bucket: inferredBucket,
      requiredStaticEvidence: 1,
      requiredFlowEvidence: inferredBucket === "flow" ? 1 : 0,
      selectedRepo,
      comparisonGroup: raw.comparison_group?.trim() || undefined,
    });

    if (normalized.length >= MAX_CLAIMS) break;
  }

  return normalized;
}

function matchKey(match: SearchMatch): string {
  return `${match.repo}:${match.path}`;
}

function claimEvidenceScore(claim: Claim, match: SearchMatch): number {
  const haystack = `${match.path}\n${match.snippet}`.toLowerCase();
  let score = 0;

  for (const kw of claim.keywords) {
    const lower = kw.toLowerCase();
    if (haystack.includes(lower)) score += 3;
  }

  if (match.path.toLowerCase().includes("main")) score += 1;
  if (match.path.toLowerCase().includes("rpc")) score += 1;

  return score;
}

interface FlowCatalogItem {
  id: string;
  keyword: string;
  chain: string;
}

interface FlowChain {
  keyword: string;
  chain: string;
}

interface ClaimRetrievalResult {
  item: ValidationItem;
  searchedKeywords: string[];
  staticMatches: SearchMatch[];
  flowChains: FlowChain[];
  filesAnalyzed: number;
  symbolsIndexed: number;
  edgesIndexed: number;
  repoErrors: string[];
}

interface ComparisonAggregate {
  group: string;
  itemIds: number[];
  repos: string[];
  status: VerificationStatus;
  confidence: VerificationConfidence;
  reason: string;
}

type ContradictionVerdict = "contradicted" | "supported" | "insufficient";

interface ContradictionSignal {
  verdict: ContradictionVerdict;
  reason: string;
}

interface AiContradictionItem {
  id?: number;
  verdict?: string;
  reason?: string;
}

interface AiContradictionResponse {
  items?: AiContradictionItem[];
}

function extractFlowChains(flow: FlowAnalysisResult | null): FlowChain[] {
  if (!flow) return [];
  const dedup = new Set<string>();
  const items: FlowChain[] = [];
  for (const group of flow.keywordChains) {
    for (const chain of group.chains) {
      const normalized = chain.trim();
      if (!normalized) continue;
      const key = `${group.keyword.toLowerCase()}::${normalized.toLowerCase()}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      items.push({ keyword: group.keyword, chain: normalized });
      if (items.length >= MAX_FLOW_ITEMS) return items;
    }
  }
  return items;
}

function compactForAi(text: string, maxChars: number): string {
  const stripped = text
    .replace(/```[a-zA-Z0-9_-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= maxChars) return stripped;
  return `${stripped.slice(0, maxChars)}...`;
}

function normalizeContradictionVerdict(v: string | undefined): ContradictionVerdict {
  const lower = (v ?? "").trim().toLowerCase();
  if (lower === "contradicted" || lower === "contradiction") return "contradicted";
  if (lower === "supported" || lower === "verified") return "supported";
  return "insufficient";
}

function parseAiContradictionResponse(raw: string): AiContradictionResponse | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? raw;
  const first = candidate.indexOf("{");
  const last = candidate.lastIndexOf("}");
  const jsonText = first >= 0 && last > first ? candidate.slice(first, last + 1) : candidate;
  try {
    return JSON.parse(jsonText) as AiContradictionResponse;
  } catch {
    return null;
  }
}

function buildContradictionPrompt(retrievals: readonly ClaimRetrievalResult[]): string {
  const payload = retrievals.slice(0, MAX_CONTRADICTION_ITEMS).map(r => ({
    id: r.item.id,
    claim: r.item.text,
    repo: r.item.selectedRepo,
    bucket: r.item.bucket,
    static_evidence: r.staticMatches.slice(0, 2).map(m => ({
      path: `${m.repo}/${m.path}`,
      snippet: compactForAi(m.snippet, MAX_CONTRADICTION_SNIPPET_CHARS),
    })),
    flow_evidence: r.flowChains.slice(0, 3).map(c => `${c.keyword}: ${c.chain}`),
  }));

  return [
    "You are checking whether each claim is contradicted by provided code evidence.",
    "Use only provided evidence. Do not use external knowledge.",
    "Return ONLY JSON with schema:",
    '{"items":[{"id":1,"verdict":"contradicted|supported|insufficient","reason":"short reason"}]}',
    "Definitions:",
    "- contradicted: evidence directly conflicts with claim.",
    "- supported: evidence supports claim and no direct conflict is present.",
    "- insufficient: evidence is not enough to decide support/contradiction.",
    "Items:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

async function detectContradictionsWithAi(
  retrievals: readonly ClaimRetrievalResult[],
): Promise<Map<number, ContradictionSignal>> {
  const byId = new Map<number, ContradictionSignal>();
  if (retrievals.length === 0) return byId;

  try {
    const raw = await askNotebookLm(buildContradictionPrompt(retrievals));
    const parsed = parseAiContradictionResponse(raw);
    for (const item of parsed?.items ?? []) {
      if (typeof item.id !== "number") continue;
      byId.set(item.id, {
        verdict: normalizeContradictionVerdict(item.verdict),
        reason: (item.reason ?? "").trim() || "No contradiction rationale provided.",
      });
    }
  } catch {
    // Best-effort signal; fallback is evidence-only scoring.
  }

  return byId;
}

function retrievalKeywordsForItem(
  item: ValidationItem,
  keywordHints: readonly string[],
): string[] {
  const fromClaim = normalizeKeywords(item.keywords);
  const fromHints = normalizeKeywords(keywordHints);
  const merged = [...fromClaim, ...fromHints];
  return [...new Set(merged)].slice(0, 8);
}

async function retrieveClaimEvidence(
  item: ValidationItem,
  keywordHints: readonly string[],
): Promise<ClaimRetrievalResult> {
  const searchedKeywords = retrievalKeywordsForItem(item, keywordHints);
  if (searchedKeywords.length === 0) {
    return {
      item,
      searchedKeywords: [],
      staticMatches: [],
      flowChains: [],
      filesAnalyzed: 0,
      symbolsIndexed: 0,
      edgesIndexed: 0,
      repoErrors: ["No retrieval keywords were provided for this validation item."],
    };
  }
  const searchResult = await searchRepos(
    searchedKeywords,
    [item.selectedRepo],
    Math.max(4, MAX_MATCHES_PER_CLAIM * 2),
  );
  const rankedStatic = [...searchResult.matches]
    .map(match => ({ match, score: claimEvidenceScore(item, match) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHES_PER_CLAIM)
    .map(x => x.match);

  let flowResult: FlowAnalysisResult | null = null;
  if (item.bucket === "flow") {
    flowResult = await analyzeRepoFlow(searchedKeywords, [item.selectedRepo], 40).catch(() => null);
  }

  const flowChains = extractFlowChains(flowResult);

  return {
    item,
    searchedKeywords,
    staticMatches: rankedStatic,
    flowChains,
    filesAnalyzed: flowResult?.filesAnalyzed ?? 0,
    symbolsIndexed: flowResult?.symbolsIndexed ?? 0,
    edgesIndexed: flowResult?.edgesIndexed ?? 0,
    repoErrors: [
      ...(searchResult.repoErrors ?? []),
      ...(flowResult?.repoErrors ?? []),
    ],
  };
}

type VerificationStatus = "Verified" | "Partially Verified" | "Not Verified" | "Contradicted" | "INSUFFICIENT_EVIDENCE";
type VerificationConfidence = "High" | "Medium" | "Low";
type ClaimCategory = "static" | "flow" | "concept" | "absence" | "comparative";

interface ClaimAssessment {
  category: ClaimCategory;
  status: VerificationStatus;
  confidence: VerificationConfidence;
  reason: string;
  fixHint: string;
}

function categorizeClaim(claim: Claim): ClaimCategory {
  const lower = claim.text.toLowerCase();

  if (
    lower.includes(" vs ") ||
    lower.includes("versus") ||
    lower.includes("between ") ||
    lower.includes("difference")
  ) {
    return "comparative";
  }

  if (
    /\b(no|not|without|omitted|excluded|absent|does not|is not|are not)\b/.test(lower)
  ) {
    return "absence";
  }

  if (
    /\b(performance|faster|latency|throughput|proof|correctness|guarantee|physical limits|bft)\b/.test(lower)
  ) {
    return "concept";
  }

  if (isFlowSensitiveClaim(claim)) {
    return "flow";
  }

  return "static";
}

function isFlowSensitiveClaim(claim: Claim): boolean {
  const lower = claim.text.toLowerCase();
  const markers = [
    "before", "after", "then", "while", "updates", "receives", "triggers",
    "calls", "passes", "handler", "actor", "flow", "pipeline", "one-writer",
    "many-readers", "shared", "wiring", "sequence",
  ];
  return markers.some(m => lower.includes(m));
}

function assessClaim(
  item: ValidationItem,
  evidenceRefs: readonly string[],
  flowRefs: readonly string[],
  repoCount: number,
  contradiction: ContradictionSignal | undefined,
): ClaimAssessment {
  const category = categorizeClaim(item);
  const hasStatic = evidenceRefs.length > 0;
  const hasFlow = flowRefs.length > 0;
  const needsFlow = isFlowSensitiveClaim(item);

  if (contradiction?.verdict === "contradicted") {
    return {
      category,
      status: "Contradicted",
      confidence: "High",
      reason: contradiction.reason,
      fixHint: "Revise this claim to match the cited implementation evidence.",
    };
  }

  if (
    evidenceRefs.length < item.requiredStaticEvidence ||
    flowRefs.length < item.requiredFlowEvidence
  ) {
    const reasonParts: string[] = [];
    if (evidenceRefs.length < item.requiredStaticEvidence) {
      reasonParts.push(
        `static evidence ${evidenceRefs.length}/${item.requiredStaticEvidence}`,
      );
    }
    if (flowRefs.length < item.requiredFlowEvidence) {
      reasonParts.push(
        `flow evidence ${flowRefs.length}/${item.requiredFlowEvidence}`,
      );
    }
    return {
      category,
      status: "INSUFFICIENT_EVIDENCE",
      confidence: "Low",
      reason: `Required minimum evidence was not met (${reasonParts.join(", ")}).`,
      fixHint: "Add targeted implementation claims/keywords or narrow repository scope to improve retrieval precision.",
    };
  }

  if (category === "comparative" && repoCount < 2) {
    return {
      category,
      status: hasStatic || hasFlow ? "Partially Verified" : "Not Verified",
      confidence: "Low",
      reason: "Comparative claim needs evidence from at least two repositories.",
      fixHint: "Provide side-by-side citations from each compared repository.",
    };
  }

  if (category === "absence") {
    if (!hasStatic && !hasFlow) {
      return {
        category,
        status: "Not Verified",
        confidence: "Low",
        reason: "Absence claim cannot be proven from current evidence set.",
        fixHint: "Add explicit code/config references or scoped exclusion criteria.",
      };
    }

    return {
      category,
      status: "Partially Verified",
      confidence: "Medium",
      reason: "Evidence supports the observed path, but global absence is not exhaustive.",
      fixHint: "Rephrase as 'not found in inspected paths' unless exhaustive proof is provided.",
    };
  }

  if (category === "concept") {
    if (hasStatic && hasFlow) {
      return {
        category,
        status: "Partially Verified",
        confidence: "Medium",
        reason: "Code flow supports implementation behavior, but conceptual claim exceeds direct proof.",
        fixHint: "Downgrade to design intent or cite formal proof/benchmark artifacts.",
      };
    }
    if (hasStatic || hasFlow) {
      return {
        category,
        status: "Partially Verified",
        confidence: "Low",
        reason: "Only indirect implementation evidence exists for conceptual claim.",
        fixHint: "Add explicit comments/docs/benchmarks proving this conceptual statement.",
      };
    }
    return {
      category,
      status: "Not Verified",
      confidence: "Low",
      reason: "No direct implementation or flow evidence supports this conceptual claim.",
      fixHint: "Remove claim or add benchmark/proof references.",
    };
  }

  if (hasStatic && (!needsFlow || hasFlow)) {
    return {
      category,
      status: "Verified",
      confidence: hasFlow || !needsFlow ? "High" : "Medium",
      reason: needsFlow
        ? "Static evidence and flow chain are both present."
        : "Static evidence directly supports this claim.",
      fixHint: "No fix required.",
    };
  }

  if (hasStatic || hasFlow) {
    return {
      category,
      status: "Partially Verified",
      confidence: "Medium",
      reason: hasStatic
        ? "Static evidence exists, but flow-level proof is incomplete."
        : "Flow chain exists, but direct static declaration evidence is missing.",
      fixHint: "Add missing static/flow evidence to fully verify this claim.",
    };
  }

  return {
    category,
    status: "Not Verified",
    confidence: "Low",
    reason: "No direct static or flow evidence was retrieved for this claim.",
    fixHint: "Add concrete code-level citations for this claim.",
  };
}

function aggregateComparativeVerdicts(
  assessments: Array<{
    item: ValidationItem;
    staticRefs: string[];
    flowRefs: string[];
    searchedKeywords: string[];
    assessment: ClaimAssessment;
  }>,
): ComparisonAggregate[] {
  const groups = new Map<string, typeof assessments>();
  for (const entry of assessments) {
    const group = entry.item.comparisonGroup;
    if (!group) continue;
    const list = groups.get(group);
    if (!list) {
      groups.set(group, [entry]);
    } else {
      list.push(entry);
    }
  }

  const out: ComparisonAggregate[] = [];
  for (const [group, entries] of groups) {
    if (entries.length < 2) continue;
    const statuses = entries.map(e => e.assessment.status);
    let status: VerificationStatus;
    let confidence: VerificationConfidence = "Low";
    let reason = "Comparison requires valid evidence for each side.";

    if (statuses.every(s => s === "Verified")) {
      status = "Verified";
      confidence = "High";
      reason = "All comparative sides are verified with required evidence.";
    } else if (statuses.some(s => s === "Contradicted")) {
      status = "Contradicted";
      confidence = "High";
      reason = "At least one comparative side is contradicted by implementation evidence.";
    } else if (statuses.some(s => s === "INSUFFICIENT_EVIDENCE")) {
      status = "INSUFFICIENT_EVIDENCE";
      confidence = "Low";
      reason = "At least one comparative side lacks minimum required evidence.";
    } else if (statuses.every(s => s === "Not Verified")) {
      status = "Not Verified";
      confidence = "Low";
      reason = "All comparative sides are not verified.";
    } else {
      status = "Partially Verified";
      confidence = "Medium";
      reason = "Comparative sides have mixed verification outcomes.";
    }

    out.push({
      group,
      itemIds: entries.map(e => e.item.id),
      repos: [...new Set(entries.map(e => e.item.selectedRepo))],
      status,
      confidence,
      reason,
    });
  }
  return out;
}

function buildResponse(
  document: string,
  items: readonly ValidationItem[],
  targetRepos: readonly string[],
  planningNotes: readonly string[],
  retrievals: readonly ClaimRetrievalResult[],
  contradictionById: ReadonlyMap<number, ContradictionSignal>,
  planningMode: "client-planned" | "ai-planned",
): string {
  const out: string[] = [];
  const repoErrors = [...new Set(retrievals.flatMap(r => r.repoErrors))];

  const evidenceScore = new Map<string, number>();
  const evidenceByKey = new Map<string, SearchMatch>();
  for (const retrieval of retrievals) {
    for (const match of retrieval.staticMatches) {
      const key = matchKey(match);
      evidenceByKey.set(key, match);
      evidenceScore.set(
        key,
        (evidenceScore.get(key) ?? 0) + claimEvidenceScore(retrieval.item, match),
      );
    }
  }

  const catalog = [...evidenceScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => evidenceByKey.get(key))
    .filter((m): m is SearchMatch => Boolean(m))
    .slice(0, MAX_EVIDENCE_ITEMS);

  const evidenceIdByKey = new Map<string, string>();
  for (let i = 0; i < catalog.length; i++) {
    evidenceIdByKey.set(matchKey(catalog[i]), `E${i + 1}`);
  }

  const flowCatalog: FlowCatalogItem[] = [];
  const flowIdByKey = new Map<string, string>();
  for (const retrieval of retrievals) {
    for (const chain of retrieval.flowChains) {
      const key = `${chain.keyword.toLowerCase()}::${chain.chain.toLowerCase()}`;
      if (flowIdByKey.has(key)) continue;
      const id = `F${flowCatalog.length + 1}`;
      flowIdByKey.set(key, id);
      flowCatalog.push({ id, keyword: chain.keyword, chain: chain.chain });
      if (flowCatalog.length >= MAX_FLOW_ITEMS) break;
    }
    if (flowCatalog.length >= MAX_FLOW_ITEMS) break;
  }

  const assessments: Array<{
    item: ValidationItem;
    staticRefs: string[];
    flowRefs: string[];
    searchedKeywords: string[];
    contradiction: ContradictionSignal | undefined;
    assessment: ClaimAssessment;
  }> = [];

  for (const retrieval of retrievals) {
    const staticRefs = retrieval.staticMatches
      .map(match => evidenceIdByKey.get(matchKey(match)))
      .filter((id): id is string => Boolean(id));

    const flowRefs = retrieval.flowChains
      .map(chain => flowIdByKey.get(`${chain.keyword.toLowerCase()}::${chain.chain.toLowerCase()}`))
      .filter((id): id is string => Boolean(id))
      .slice(0, 3);

    const assessment = assessClaim(
      retrieval.item,
      staticRefs,
      flowRefs,
      targetRepos.length,
      contradictionById.get(retrieval.item.id),
    );

    assessments.push({
      item: retrieval.item,
      staticRefs,
      flowRefs,
      searchedKeywords: retrieval.searchedKeywords,
      contradiction: contradictionById.get(retrieval.item.id),
      assessment,
    });
  }

  const verifiedCount = assessments.filter(a => a.assessment.status === "Verified").length;
  const partialCount = assessments.filter(a => a.assessment.status === "Partially Verified").length;
  const notVerifiedCount = assessments.filter(a => a.assessment.status === "Not Verified").length;
  const contradictedCount = assessments.filter(a => a.assessment.status === "Contradicted").length;
  const insufficientCount = assessments.filter(a => a.assessment.status === "INSUFFICIENT_EVIDENCE").length;
  const totalFilesAnalyzed = retrievals.reduce((sum, r) => sum + r.filesAnalyzed, 0);
  const totalSymbols = retrievals.reduce((sum, r) => sum + r.symbolsIndexed, 0);
  const totalEdges = retrievals.reduce((sum, r) => sum + r.edgesIndexed, 0);
  const comparisons = aggregateComparativeVerdicts(assessments);

  out.push("## Summary");
  out.push(`- Scope: repos=${targetRepos.join(", ")}, branch=main.`);
  out.push(`- Items evaluated: ${assessments.length} (Verified=${verifiedCount}, Partially Verified=${partialCount}, Not Verified=${notVerifiedCount}, Contradicted=${contradictedCount}, INSUFFICIENT_EVIDENCE=${insufficientCount}).`);
  out.push(`- Flow coverage: files=${totalFilesAnalyzed}, symbols=${totalSymbols}, edges=${totalEdges}.`);

  out.push("");
  out.push("## Stage 1: Repository Selection and Validation Items");
  out.push(`- Validation planning mode: ${planningMode}.`);
  out.push(`- Repo selection mode: ${planningMode === "client-planned" ? "client-provided" : "ai-planned"}.`);
  if (planningNotes.length > 0) {
    out.push("- Planning notes:");
    for (const reason of planningNotes.slice(0, 6)) {
      out.push(`  - ${reason}`);
    }
  }
  out.push("- Validation items:");
  for (const item of items) {
    out.push(
      `  - [${item.id}] repo=${item.selectedRepo}, bucket=${item.bucket}, minimum_evidence=(static:${item.requiredStaticEvidence}, flow:${item.requiredFlowEvidence})${item.comparisonGroup ? `, comparison_group=${item.comparisonGroup}` : ""} :: ${truncateInline(item.text, 170)}`,
    );
  }

  out.push("");
  out.push("## Stage 2: Implementation Retrieval");
  out.push("- Retrieval path: per-item retrieval using the same backend as `search_implementation` (`searchRepos`) plus flow reconstruction (`analyzeRepoFlow`) for flow items.");
  for (const item of assessments) {
    out.push(
      `- Item ${item.item.id}: keywords=\`${item.searchedKeywords.join(" ")}\`, static=${item.staticRefs.length}, flow=${item.flowRefs.length}, contradiction=${item.contradiction?.verdict ?? "insufficient"}`,
    );
  }
  if (repoErrors.length > 0) {
    out.push("- Retrieval warnings:");
    for (const err of repoErrors.slice(0, 12)) {
      out.push(`  - ${err}`);
    }
  }

  out.push("");
  out.push("## Stage 3: Fact Check Verdict");
  out.push("| ID | Repo | Bucket | Claim (short) | Verdict | Contradiction Reason | Evidence | Flow | Confidence |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const item of assessments) {
    const shortClaim = truncateInline(item.item.text, 64).replace(/\|/g, "/");
    const e = item.staticRefs.length > 0 ? item.staticRefs.join(",") : "-";
    const f = item.flowRefs.length > 0 ? item.flowRefs.join(",") : "-";
    const contradictionReason = item.contradiction?.verdict === "contradicted"
      ? truncateInline(item.contradiction.reason, 90).replace(/\|/g, "/")
      : "-";
    out.push(`| ${item.item.id} | ${item.item.selectedRepo} | ${item.item.bucket} | ${shortClaim} | ${item.assessment.status} | ${contradictionReason} | ${e} | ${f} | ${item.assessment.confidence} |`);
  }

  if (comparisons.length > 0) {
    out.push("");
    out.push("### Comparative Verdicts");
    out.push("| Group | Repos | Sub-items | Combined Verdict | Confidence | Reason |");
    out.push("|---|---|---|---|---|---|");
    for (const comp of comparisons) {
      out.push(`| ${comp.group} | ${comp.repos.join(", ")} | ${comp.itemIds.join(", ")} | ${comp.status} | ${comp.confidence} | ${truncateInline(comp.reason, 120).replace(/\|/g, "/")} |`);
    }
  }

  out.push("");
  out.push("## Fixes Required");
  const needsFix = assessments.filter(a => a.assessment.status !== "Verified");
  if (needsFix.length === 0) {
    out.push("1. No immediate corrections required from current evidence scope.");
  } else {
    for (let i = 0; i < needsFix.length; i++) {
      const item = needsFix[i];
      out.push(`${i + 1}. Claim: ${truncateInline(item.item.text, 200)}`);
      out.push(`   Why it fails: ${item.assessment.reason}`);
      out.push(`   Evidence refs: ${item.staticRefs.length > 0 ? item.staticRefs.join(", ") : "-"}${item.flowRefs.length > 0 ? ` | flow=${item.flowRefs.join(", ")}` : ""}`);
      out.push(`   How to fix: ${item.assessment.fixHint}`);
    }
  }

  out.push("");
  out.push("## Reasoning");
  out.push(`- Static evidence: ${catalog.length} curated snippets were linked to claim-level items.`);
  out.push(`- Flow evidence: ${flowCatalog.length} call-chain snippets were linked to flow items.`);
  out.push("- Contradiction detection: AI adjudication is applied to claim + retrieved evidence to flag direct conflicts with implementation.");
  out.push("- Minimum evidence policy: when required minimum static/flow evidence is missing, verdict is `INSUFFICIENT_EVIDENCE` (no fallback inference).");

  out.push("");
  out.push("## Evidence Appendix");
  out.push(`- Source document size: ${document.length} chars`);
  if (catalog.length > 0) {
    out.push("");
    out.push("### Static Evidence");
    for (const match of catalog) {
      const evidenceId = evidenceIdByKey.get(matchKey(match)) ?? "E?";
      out.push(`#### ${evidenceId} — ${match.repo} — ${match.path}`);
      out.push(truncate(match.snippet, MAX_EVIDENCE_SNIPPET_CHARS));
      out.push("");
    }
  }

  if (flowCatalog.length > 0) {
    out.push("### Flow Evidence");
    for (const item of flowCatalog) {
      out.push(`- ${item.id} [keyword=${item.keyword}] ${item.chain}`);
    }
  }

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerFactCheckTool(server: McpServer): void {
  const repoList = REFERENCE_REPOS.join(", ");

  server.registerTool("factcheck", {
    title: "FactCheck",
    description:
      `Validate a document against actual code in reference repos (${repoList}). ` +
      "Pipeline: (1) AI plans validation items (fact/flow/component) with explicit per-item repo mapping, " +
      "(2) retrieve per-item implementation evidence with search backend and call-chain analysis, " +
      "(3) detect contradiction between claims and code evidence, then emit verdicts with strict minimum evidence thresholds.\n\n" +
      "If `repos` is omitted, AI can choose from all REFERENCE_REPOS. " +
      "Repository retrieval is pinned to the `main` branch only. " +
      "When minimum evidence is not met, verdict is `INSUFFICIENT_EVIDENCE`. " +
      "For best latency/control, pass `validation_items` directly from client planning.",
    inputSchema: {
      document: z.string().optional().describe(
        "The document or text to fact-check."
      ),
      claims: z.array(z.string()).optional().describe(
        "Optional explicit claims to append to the planning input."
      ),
      validation_items: z.array(z.object({
        text: z.string(),
        bucket: z.string().optional(),
        keywords: z.array(z.string()).optional(),
        selected_repo: z.string().optional(),
        comparison_group: z.string().optional(),
      })).optional().describe(
        "Preferred fast path: client-planned validation items. If provided, the tool skips document claim extraction. Each item should map to one `selected_repo`."
      ),
      keywords: z.array(z.string()).optional().describe(
        "Optional hint keywords. Usually not required."
      ),
      repos: z.array(z.string()).optional().describe(
        `Optional allowed-repo subset for AI planning. If omitted, all are allowed: ${repoList}`
      ),
    },
  }, async ({ document, claims: explicitClaims, validation_items, keywords, repos }) => {
    const effectiveDocument = (document ?? "").trim();
    const explicitClaimText = (explicitClaims ?? [])
      .map(c => cleanClaimText(c))
      .filter(Boolean);

    if (!effectiveDocument && explicitClaimText.length === 0 && (validation_items?.length ?? 0) === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No validation target provided. Supply `document` or `claims`, or provide non-empty `validation_items`.",
        }],
      };
    }

    const candidateRepos = repos?.length ? [...repos] : [...REFERENCE_REPOS];
    validateRepos(candidateRepos);

    const keywordHints = normalizeKeywords(keywords ?? []);
    const plannedItems = validation_items?.length
      ? normalizeClientValidationItems(validation_items, candidateRepos)
      : [];
    let validationItems = plannedItems;
    let planningNotes: string[] = [];

    if (validationItems.length === 0) {
      const planningInput = [
        effectiveDocument ? `Document:\n${effectiveDocument}` : "",
        explicitClaimText.length > 0 ? `Claims:\n${explicitClaimText.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : "",
      ].filter(Boolean).join("\n\n");

      const aiPlan = await planValidationItemsWithAi(planningInput, candidateRepos);
      validationItems = aiPlan.items;
      planningNotes = aiPlan.notes;

      if (validationItems.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: [
              "AI planning failed to produce actionable validation items.",
              "Ensure the document/claims include concrete technical statements and try again.",
              `Planner raw output (truncated): ${truncateInline(aiPlan.raw, 1200)}`,
            ].join("\n"),
          }],
        };
      }
    }

    const targetRepos = [...new Set(validationItems.map(i => i.selectedRepo))];
    if (targetRepos.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No valid repository mapping was produced for validation items.",
        }],
      };
    }

    if (validationItems.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No actionable validation items were extracted. Provide concrete technical claims (fact/flow/component) to validate.",
        }],
      };
    }
    const retrievals = await Promise.all(
      validationItems.map(item => retrieveClaimEvidence(item, keywordHints)),
    );
    const contradictionById = await detectContradictionsWithAi(retrievals);

    const text = buildResponse(
      effectiveDocument,
      validationItems,
      targetRepos,
      planningNotes,
      retrievals,
      contradictionById,
      plannedItems.length > 0 ? "client-planned" : "ai-planned",
    );

    if (text.length > MAX_RESPONSE_BYTES) {
      // Keep response under control for clients with stricter token limits.
      return {
        content: [{
          type: "text" as const,
          text: `${truncate(text, MAX_RESPONSE_BYTES)}\n\n...(output truncated due size)`
        }],
      };
    }

    return { content: [{ type: "text" as const, text }] };
  });
}
