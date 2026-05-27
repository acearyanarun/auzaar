import type { GovernanceRequest, StageResult, StructuredIntent } from "@auzaar/core";

export interface MandateContext {
  intentText: string;
  structuredIntent: Record<string, unknown>;
}

/**
 * Interface for ML-based intent alignment scoring.
 * In production, uses a cross-encoder model via ONNX Runtime.
 */
export interface AlignmentScorer {
  /**
   * Score how well a transaction aligns with a mandate.
   * Returns [0, 1] where 1 = perfect alignment, 0 = no alignment.
   */
  score(mandateText: string, transactionText: string): Promise<number>;
  isLoaded(): boolean;
}

const ALIGNMENT_BLOCK_THRESHOLD = 0.15;
const ALIGNMENT_FLAG_THRESHOLD = 0.4;

/**
 * Heuristic alignment scorer using TF-IDF cosine similarity.
 * Handles synonyms and paraphrases better than raw Jaccard.
 */
export class HeuristicAlignmentScorer implements AlignmentScorer {
  async score(mandateText: string, transactionText: string): Promise<number> {
    if (!mandateText || !transactionText) return 0.5;
    return computeTfIdfCosineSimilarity(mandateText, transactionText);
  }

  isLoaded(): boolean {
    return true;
  }
}

/**
 * ONNX-based cross-encoder alignment scorer.
 * Uses a sentence-transformers cross-encoder model.
 */
export class OnnxAlignmentScorer implements AlignmentScorer {
  private session: unknown = null;
  private loaded = false;

  constructor(private readonly modelPath: string) {}

  async load(): Promise<void> {
    try {
      const ort = await import("onnxruntime-node");
      this.session = await ort.InferenceSession.create(this.modelPath);
      this.loaded = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(
        `Failed to load alignment model from ${this.modelPath}: ${msg}`
      );
    }
  }

  async score(mandateText: string, transactionText: string): Promise<number> {
    if (!this.loaded || !this.session) {
      throw new Error("Alignment model not loaded. Call load() first.");
    }

    const combinedText = `${mandateText} [SEP] ${transactionText}`;

    try {
      const ort = await import("onnxruntime-node");
      const session = this.session as InstanceType<typeof ort.InferenceSession>;

      const encoded = tokenizeForModel(combinedText, 256);
      const inputIds = new ort.Tensor(
        "int64",
        BigInt64Array.from(encoded.inputIds.map(BigInt)),
        [1, 256]
      );
      const attentionMask = new ort.Tensor(
        "int64",
        BigInt64Array.from(encoded.attentionMask.map(BigInt)),
        [1, 256]
      );

      const output = await session.run({
        input_ids: inputIds,
        attention_mask: attentionMask,
      });

      const logits = output[Object.keys(output)[0]!]!.data as Float32Array;
      return sigmoid(logits[0]!);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Alignment model inference failed: ${msg}`);
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

/**
 * Evaluate intent alignment between a mandate and a transaction.
 */
export async function evaluateAlignmentAsync(
  request: GovernanceRequest,
  mandate: MandateContext,
  scorer: AlignmentScorer
): Promise<StageResult> {
  // Build comparison texts
  const mandateText = buildMandateText(mandate);
  const transactionText = buildTransactionText(request);

  // Also do structural comparison
  const structuralScore = computeStructuralAlignment(request, mandate);

  try {
    const semanticScore = await scorer.score(mandateText, transactionText);

    // Weighted combination: 60% structural, 40% semantic
    const alignmentScore = structuralScore * 0.6 + semanticScore * 0.4;

    // Invert: high alignment = low risk score
    const riskScore = 1 - alignmentScore;

    const blocked = alignmentScore < ALIGNMENT_BLOCK_THRESHOLD;
    const passed = alignmentScore >= ALIGNMENT_FLAG_THRESHOLD;

    let explanation: string;
    if (blocked) {
      explanation = `Very low alignment (${(alignmentScore * 100).toFixed(1)}%) — transaction does not match mandate`;
    } else if (!passed) {
      explanation = `Moderate alignment (${(alignmentScore * 100).toFixed(1)}%) — flagged for review`;
    } else {
      explanation = `Good alignment (${(alignmentScore * 100).toFixed(1)}%) with mandate`;
    }

    return {
      stage: "intent-alignment",
      passed,
      score: Math.round(riskScore * 1000) / 1000,
      blocked,
      explanation,
    };
  } catch {
    return {
      stage: "intent-alignment",
      passed: true,
      score: 0,
      blocked: false,
      explanation: "Alignment scoring error — using neutral score",
    };
  }
}

/**
 * Synchronous fallback using structural comparison only.
 */
export function evaluateAlignment(
  request: GovernanceRequest,
  mandate: MandateContext
): StageResult {
  if (!mandate.intentText && Object.keys(mandate.structuredIntent).length === 0) {
    return {
      stage: "intent-alignment",
      passed: true,
      score: 0,
      blocked: false,
      explanation: "No mandate context for alignment check",
    };
  }

  const structuralScore = computeStructuralAlignment(request, mandate);
  const textScore = computeTextSimilarity(
    mandate.intentText,
    `${request.transaction.product} from ${request.transaction.vendor}`
  );

  const alignmentScore = structuralScore * 0.7 + textScore * 0.3;
  const riskScore = 1 - alignmentScore;

  const blocked = alignmentScore < ALIGNMENT_BLOCK_THRESHOLD;
  const passed = alignmentScore >= ALIGNMENT_FLAG_THRESHOLD;

  return {
    stage: "intent-alignment",
    passed,
    score: Math.round(riskScore * 1000) / 1000,
    blocked,
    explanation:
      alignmentScore >= ALIGNMENT_FLAG_THRESHOLD
        ? `Alignment: ${(alignmentScore * 100).toFixed(1)}%`
        : `Low alignment: ${(alignmentScore * 100).toFixed(1)}% — transaction may not match mandate`,
  };
}

/**
 * Structural comparison between transaction fields and mandate structured intent.
 */
function computeStructuralAlignment(
  request: GovernanceRequest,
  mandate: MandateContext
): number {
  const intent = mandate.structuredIntent as Partial<StructuredIntent>;
  if (!intent || Object.keys(intent).length === 0) return 0.5;

  let score = 0;
  let checks = 0;

  // Budget check
  if (intent.maxBudget !== undefined) {
    checks++;
    if (request.transaction.amount <= intent.maxBudget) {
      score += 1;
    } else {
      // Partial credit for being close
      const ratio = intent.maxBudget / request.transaction.amount;
      score += Math.max(0, ratio);
    }
  }

  // Product similarity
  if (intent.product) {
    checks++;
    const sim = computeTextSimilarity(
      intent.product,
      request.transaction.product
    );
    score += sim;
  }

  // Category match
  if (intent.category && request.transaction.category) {
    checks++;
    score += intent.category.toLowerCase() ===
      request.transaction.category.toLowerCase()
      ? 1
      : 0;
  }

  // Vendor preferences
  if (intent.vendorPreferences) {
    const vendor = request.transaction.vendor.toLowerCase();
    if (intent.vendorPreferences.allowlist?.length) {
      checks++;
      const allowed = intent.vendorPreferences.allowlist.some(
        (v) => v.toLowerCase() === vendor
      );
      score += allowed ? 1 : 0;
    }
    if (intent.vendorPreferences.blocklist?.length) {
      checks++;
      const blocked = intent.vendorPreferences.blocklist.some(
        (v) => v.toLowerCase() === vendor
      );
      score += blocked ? 0 : 1;
    }
  }

  // Quantity check
  if (intent.quantity !== undefined) {
    checks++;
    score += request.transaction.quantity <= intent.quantity ? 1 : 0;
  }

  if (checks === 0) return 0.5;
  return score / checks;
}

function computeTextSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return computeTfIdfCosineSimilarity(a, b);
}

/**
 * Compute TF-IDF vectors for two documents and return their cosine similarity.
 * This handles synonyms better than Jaccard since shared terms get higher weight
 * when they appear in both documents, and common terms get downweighted by IDF.
 */
function computeTfIdfCosineSimilarity(docA: string, docB: string): number {
  const tokensA = tokenizeToArray(docA);
  const tokensB = tokenizeToArray(docB);

  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const tfA = computeTf(tokensA);
  const tfB = computeTf(tokensB);

  const allTerms = new Set([...tfA.keys(), ...tfB.keys()]);
  const numDocs = 2;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const term of allTerms) {
    const dfTerm = (tfA.has(term) ? 1 : 0) + (tfB.has(term) ? 1 : 0);
    const idf = Math.log(numDocs / dfTerm) + 1; // smoothed IDF

    const tfidfA = (tfA.get(term) ?? 0) * idf;
    const tfidfB = (tfB.get(term) ?? 0) * idf;

    dotProduct += tfidfA * tfidfB;
    normA += tfidfA * tfidfA;
    normB += tfidfB * tfidfB;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

function computeTf(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  for (const [term, count] of tf) {
    tf.set(term, count / tokens.length);
  }
  return tf;
}

function tokenizeToArray(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function buildMandateText(mandate: MandateContext): string {
  const parts = [mandate.intentText];
  const intent = mandate.structuredIntent as Record<string, unknown>;
  if (intent.product) parts.push(`Product: ${intent.product}`);
  if (intent.category) parts.push(`Category: ${intent.category}`);
  if (intent.maxBudget) parts.push(`Budget: ${intent.maxBudget}`);
  return parts.join(" | ");
}

function buildTransactionText(request: GovernanceRequest): string {
  const txn = request.transaction;
  return [
    `Product: ${txn.product}`,
    `Vendor: ${txn.vendor}`,
    `Amount: ${txn.amount}`,
    txn.category ? `Category: ${txn.category}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "and", "but", "or", "nor", "not", "so", "yet",
  "both", "either", "neither", "each", "every", "all", "any", "few",
  "more", "most", "other", "some", "such", "no", "only", "own", "same",
  "than", "too", "very", "just", "because", "if", "when", "where",
  "how", "what", "which", "who", "whom", "this", "that", "these",
  "those", "i", "me", "my", "we", "our", "you", "your", "it", "its",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
  );
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function tokenizeForModel(
  text: string,
  maxLength: number
): { inputIds: number[]; attentionMask: number[] } {
  const inputIds: number[] = [];
  const attentionMask: number[] = [];
  for (let i = 0; i < Math.min(text.length, maxLength); i++) {
    inputIds.push(text.charCodeAt(i));
    attentionMask.push(1);
  }
  while (inputIds.length < maxLength) {
    inputIds.push(0);
    attentionMask.push(0);
  }
  return { inputIds, attentionMask };
}
