interface SuggestionFlowContext {
  question: string;
  repos: string[];
  keywords: string[];
  createdAtMs: number;
}

const FLOW_TTL_MS = 2 * 60 * 60 * 1000;
let latestContext: SuggestionFlowContext | null = null;

function getIfFresh(ctx: SuggestionFlowContext | null): SuggestionFlowContext | null {
  if (!ctx) return null;
  if (Date.now() - ctx.createdAtMs > FLOW_TTL_MS) {
    return null;
  }
  const copy = {
    question: ctx.question,
    repos: [...ctx.repos],
    keywords: [...ctx.keywords],
    createdAtMs: ctx.createdAtMs,
  };
  return copy;
}

export function createSuggestionFlowContext(input: {
  question: string;
  repos: string[];
  keywords: string[];
}): void {
  latestContext = {
    question: input.question,
    repos: [...input.repos],
    keywords: [...input.keywords],
    createdAtMs: Date.now(),
  };
}

export function getLatestSuggestionFlowContext(): SuggestionFlowContext | null {
  latestContext = getIfFresh(latestContext);
  return getIfFresh(latestContext);
}
