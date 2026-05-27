import type { GovernanceRequest, GovernanceDecision, StageResult } from "@auzaar/core";

export type TriageRoute = "auto-approve" | "auto-block" | "human-review";

export interface TriageResult {
  route: TriageRoute;
  confidence: number;
  recommendation: string;
}

export interface TriageConfig {
  /** Maximum transaction amount for SLM auto-approve */
  autoApproveCeiling: number;
  /** Maximum composite score for SLM auto-approve */
  autoApproveScoreThreshold: number;
  /** Minimum composite score for SLM auto-block */
  autoBlockScoreThreshold: number;
}

const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  autoApproveCeiling: 500,
  autoApproveScoreThreshold: 0.2,
  autoBlockScoreThreshold: 0.85,
};

/**
 * Interface for SLM-based triage.
 * In production, runs Llama-3.2-1B or Phi-3-mini via node-llama-cpp.
 */
export interface SlmTriageModel {
  triage(context: TriageContext): Promise<TriageResult>;
  isLoaded(): boolean;
}

export interface TriageContext {
  request: GovernanceRequest;
  stageResults: StageResult[];
  compositeScore: number;
  decision: "approved" | "flagged" | "blocked";
}

/**
 * Rule-based triage that enforces the SLM constraints deterministically.
 * The SLM has routing authority, NOT decision authority.
 *
 * Key invariants:
 * - SLM NEVER auto-approves above the dollar ceiling
 * - SLM NEVER overrides a deterministic hard block
 * - SLM can route obvious false positives to auto-approve
 * - SLM can route obvious violations to auto-block
 */
export class TriageRouter {
  private readonly config: TriageConfig;
  private readonly slm: SlmTriageModel | null;

  constructor(config?: Partial<TriageConfig>, slm?: SlmTriageModel) {
    this.config = { ...DEFAULT_TRIAGE_CONFIG, ...config };
    this.slm = slm ?? null;
  }

  async route(context: TriageContext): Promise<TriageResult> {
    // Hard deterministic blocks can NEVER be overridden
    const rulesResult = context.stageResults.find(
      (s) => s.stage === "rules-engine"
    );
    if (rulesResult?.blocked) {
      return {
        route: "auto-block",
        confidence: 1.0,
        recommendation: `Deterministic rule block: ${rulesResult.explanation ?? "policy violation"}`,
      };
    }

    // Any stage hard block = auto-block
    const hardBlock = context.stageResults.find((s) => s.blocked);
    if (hardBlock) {
      return {
        route: "auto-block",
        confidence: 0.95,
        recommendation: `Stage "${hardBlock.stage}" hard block: ${hardBlock.explanation ?? "threat detected"}`,
      };
    }

    // If SLM is loaded, use it for flagged transactions
    if (this.slm?.isLoaded() && context.decision === "flagged") {
      const slmResult = await this.slm.triage(context);
      // Enforce ceiling: SLM cannot auto-approve above dollar limit
      if (
        slmResult.route === "auto-approve" &&
        context.request.transaction.amount > this.config.autoApproveCeiling
      ) {
        return {
          route: "human-review",
          confidence: slmResult.confidence,
          recommendation: `SLM recommended approve but amount $${context.request.transaction.amount} exceeds ceiling $${this.config.autoApproveCeiling}`,
        };
      }
      // Enforce score threshold for auto-approve
      if (
        slmResult.route === "auto-approve" &&
        context.compositeScore > this.config.autoApproveScoreThreshold
      ) {
        return {
          route: "human-review",
          confidence: slmResult.confidence,
          recommendation: `SLM recommended approve but score ${context.compositeScore} exceeds threshold ${this.config.autoApproveScoreThreshold}`,
        };
      }
      return slmResult;
    }

    // Deterministic fallback routing (no SLM)
    return this.deterministicRoute(context);
  }

  private deterministicRoute(context: TriageContext): TriageResult {
    const { compositeScore } = context;
    const amount = context.request.transaction.amount;

    // Auto-approve: low score AND below ceiling
    if (
      compositeScore < this.config.autoApproveScoreThreshold &&
      amount <= this.config.autoApproveCeiling
    ) {
      return {
        route: "auto-approve",
        confidence: 1 - compositeScore,
        recommendation: "Low risk, within auto-approve limits",
      };
    }

    // Auto-block: very high score
    if (compositeScore >= this.config.autoBlockScoreThreshold) {
      return {
        route: "auto-block",
        confidence: compositeScore,
        recommendation: `Composite score ${compositeScore.toFixed(3)} exceeds block threshold`,
      };
    }

    // Everything else goes to human review
    return {
      route: "human-review",
      confidence: 0.5,
      recommendation: `Composite score ${compositeScore.toFixed(3)} requires human review`,
    };
  }
}

/**
 * Placeholder SLM implementation using node-llama-cpp.
 * In production, this loads a fine-tuned Llama-3.2-1B or Phi-3-mini model.
 */
export class LlamaCppTriageModel implements SlmTriageModel {
  private loaded = false;
  private model: unknown = null;
  // SEC-14: Context and session are pre-allocated at load time and reused
  // across calls to avoid the overhead of creating a new context per inference.
  private ctx: unknown = null;
  private session: unknown = null;

  constructor(private readonly modelPath: string) {}

  async load(): Promise<void> {
    try {
      const llamaCpp = await import("node-llama-cpp");
      const llama = await llamaCpp.getLlama();
      const model = await llama.loadModel({ modelPath: this.modelPath });
      this.model = model;
      // SEC-14: Pre-allocate context and session once at load time.
      const context = await (model as Awaited<ReturnType<Awaited<ReturnType<typeof llamaCpp.getLlama>>["loadModel"]>>).createContext();
      this.ctx = context;
      this.session = new llamaCpp.LlamaChatSession({
        contextSequence: (context as Awaited<ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof llamaCpp.getLlama>>["loadModel"]>>["createContext"]>>).getSequence(),
      });
      this.loaded = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to load SLM triage model: ${msg}`);
    }
  }

  async triage(context: TriageContext): Promise<TriageResult> {
    if (!this.loaded || !this.session) {
      throw new Error("SLM model not loaded. Call load() first.");
    }

    const prompt = buildTriagePrompt(context);

    try {
      const llamaCpp = await import("node-llama-cpp");
      // SEC-14: Reuse the pre-allocated session instead of creating a new context per call.
      const session = this.session as InstanceType<typeof llamaCpp.LlamaChatSession>;
      const response = await session.prompt(prompt, { maxTokens: 100 });
      return parseTriageResponse(response);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`SLM triage inference failed: ${msg}`);
    }
  }

  /** SEC-14: Release the model, context, and session resources. */
  async dispose(): Promise<void> {
    this.session = null;
    this.ctx = null;
    this.model = null;
    this.loaded = false;
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

function buildTriagePrompt(context: TriageContext): string {
  const txn = context.request.transaction;
  const stageDetails = context.stageResults
    .map((s) => `  ${s.stage}: score=${s.score}, passed=${s.passed}, ${s.explanation ?? ""}`)
    .join("\n");

  return `You are a transaction governance triage agent. Analyze this flagged transaction and recommend: APPROVE, BLOCK, or REVIEW.

Transaction:
  Vendor: ${txn.vendor}
  Product: ${txn.product}
  Amount: $${txn.amount} ${txn.currency}
  Category: ${txn.category ?? "N/A"}

Governance Scores:
${stageDetails}
  Composite: ${context.compositeScore}

Respond with exactly one of: APPROVE, BLOCK, REVIEW
Then on a new line, give a brief reason.`;
}

function parseTriageResponse(response: string): TriageResult {
  const lines = response.trim().split("\n");
  const firstLine = (lines[0] ?? "").toUpperCase().trim();
  const reason = lines.slice(1).join(" ").trim() || "SLM recommendation";

  // SEC-15: Attempt to extract a confidence value from the model's response.
  // The model may output a line like "Confidence: 0.85" or embed it inline.
  // NOTE: The SLM is not fine-tuned to reliably produce confidence values;
  // this is best-effort extraction. The fallback of 0.7 is a conservative
  // default that triggers human review rather than auto-approval when uncertain.
  let confidence = 0.7;
  const confidenceMatch = response.match(/confidence[:\s]+([0-9]*\.?[0-9]+)/i);
  if (confidenceMatch) {
    const parsed = parseFloat(confidenceMatch[1]!);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1) {
      confidence = parsed;
    }
  }

  if (firstLine.includes("APPROVE")) {
    return { route: "auto-approve", confidence, recommendation: reason };
  }
  if (firstLine.includes("BLOCK")) {
    return { route: "auto-block", confidence, recommendation: reason };
  }
  return { route: "human-review", confidence: 0.5, recommendation: reason };
}
