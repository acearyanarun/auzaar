import type { GovernanceRequest, StageResult } from "@auzaar/core";

/**
 * Interface for the ONNX-based threat classifier.
 * In production, this wraps onnxruntime-node running a DistilBERT model.
 */
export interface ThreatClassifier {
  /**
   * Classify a transaction context for potential threats.
   * Returns a probability [0, 1] where higher = more likely threat.
   */
  classify(input: ThreatInput): Promise<number>;
  isLoaded(): boolean;
}

export interface ThreatInput {
  vendor: string;
  product: string;
  amount: number;
  category?: string;
  agentId: string;
  intentText?: string;
  transactionContext: string;
}

const THREAT_BLOCK_THRESHOLD = 0.85;
const THREAT_FLAG_THRESHOLD = 0.5;

/**
 * Heuristic threat detector that runs when no ML model is loaded.
 * Checks for common adversarial patterns in commerce transactions.
 */
export class HeuristicThreatDetector implements ThreatClassifier {
  private static readonly SUSPICIOUS_PATTERNS = [
    /prompt\s*inject/i,
    /ignore\s*(previous|above|all)\s*(instructions?|rules?)/i,
    /system\s*prompt/i,
    /jailbreak/i,
    /do\s*not\s*follow\s*(policy|rules)/i,
    /bypass\s*(governance|policy|rules|mandate)/i,
    /act\s*as\s*if\s*you\s*are/i,
    /pretend\s*(you|that)/i,
    /override\s*(mandate|policy|limit)/i,
  ];

  private static readonly SUSPICIOUS_VENDOR_PATTERNS = [
    /crypto.*exchange/i,
    /anonymous/i,
    /dark.*market/i,
    /money.*launder/i,
  ];

  async classify(input: ThreatInput): Promise<number> {
    let score = 0;

    // Check for prompt injection in text fields
    const textFields = [
      input.product,
      input.vendor,
      input.category ?? "",
      input.intentText ?? "",
      input.transactionContext,
    ].join(" ");

    for (const pattern of HeuristicThreatDetector.SUSPICIOUS_PATTERNS) {
      if (pattern.test(textFields)) {
        score = Math.max(score, 0.9);
        break;
      }
    }

    // Suspicious vendor patterns
    for (const pattern of HeuristicThreatDetector.SUSPICIOUS_VENDOR_PATTERNS) {
      if (pattern.test(input.vendor)) {
        score = Math.max(score, 0.7);
        break;
      }
    }

    // Suspiciously round large amounts
    if (input.amount >= 1000 && input.amount % 1000 === 0) {
      score = Math.max(score, 0.2);
    }

    // Very large single transactions
    if (input.amount >= 10000) {
      score = Math.max(score, 0.3);
    }

    return score;
  }

  isLoaded(): boolean {
    return true;
  }
}

/**
 * ONNX-based threat classifier using DistilBERT.
 * Requires onnxruntime-node and a trained model file.
 */
export class OnnxThreatClassifier implements ThreatClassifier {
  private session: unknown = null;
  private loaded = false;

  constructor(private readonly modelPath: string) {}

  async load(): Promise<void> {
    try {
      // Dynamic import to avoid hard dependency on onnxruntime-node
      const ort = await import("onnxruntime-node");
      this.session = await ort.InferenceSession.create(this.modelPath);
      this.loaded = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to load threat model from ${this.modelPath}: ${msg}`);
    }
  }

  async classify(input: ThreatInput): Promise<number> {
    if (!this.loaded || !this.session) {
      throw new Error("Threat model not loaded. Call load() first.");
    }

    // Tokenize input into a combined text representation
    const text = [
      `vendor: ${input.vendor}`,
      `product: ${input.product}`,
      `amount: ${input.amount}`,
      input.category ? `category: ${input.category}` : "",
      `context: ${input.transactionContext}`,
    ]
      .filter(Boolean)
      .join(" | ");

    try {
      const ort = await import("onnxruntime-node");
      const session = this.session as InstanceType<typeof ort.InferenceSession>;

      // Simple character-level tokenization as placeholder
      // In production, use a proper DistilBERT tokenizer
      const encoded = tokenizeSimple(text, 128);
      const inputIds = new ort.Tensor("int64", BigInt64Array.from(encoded.map(BigInt)), [1, 128]);
      const attentionMask = new ort.Tensor(
        "int64",
        BigInt64Array.from(encoded.map((v) => BigInt(v > 0 ? 1 : 0))),
        [1, 128]
      );

      const output = await session.run({
        input_ids: inputIds,
        attention_mask: attentionMask,
      });

      // Expect a single logit output; apply sigmoid
      const logits = output[Object.keys(output)[0]!]!.data as Float32Array;
      return sigmoid(logits[0]!);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Threat model inference failed: ${msg}`);
    }
  }

  isLoaded(): boolean {
    return this.loaded;
  }
}

/**
 * Evaluate threat for a governance request.
 * Uses the provided classifier or falls back to heuristics.
 */
export async function evaluateThreatAsync(
  request: GovernanceRequest,
  classifier: ThreatClassifier,
  mandateIntentText?: string
): Promise<StageResult> {
  const input: ThreatInput = {
    vendor: request.transaction.vendor,
    product: request.transaction.product,
    amount: request.transaction.amount,
    category: request.transaction.category,
    agentId: request.agentId,
    intentText: mandateIntentText,
    transactionContext: JSON.stringify(request.transaction.metadata ?? {}),
  };

  try {
    const threatScore = await classifier.classify(input);

    const blocked = threatScore >= THREAT_BLOCK_THRESHOLD;
    const passed = threatScore < THREAT_FLAG_THRESHOLD;

    let explanation: string;
    if (blocked) {
      explanation = `High threat probability (${(threatScore * 100).toFixed(1)}%) — transaction blocked`;
    } else if (!passed) {
      explanation = `Elevated threat probability (${(threatScore * 100).toFixed(1)}%) — flagged for review`;
    } else {
      explanation = `Low threat probability (${(threatScore * 100).toFixed(1)}%)`;
    }

    return {
      stage: "threat-detection",
      passed,
      score: Math.round(threatScore * 1000) / 1000,
      blocked,
      explanation,
    };
  } catch {
    // SEC-20: Fail-closed — a threat detection error returns a high risk score
    // (0.9) rather than a neutral 0, so classifier failures don't silently
    // zero out threat detection and allow potentially malicious transactions through.
    return {
      stage: "threat-detection",
      passed: false,
      score: 0.9,
      blocked: true,
      explanation: "Threat detection error — failing closed with high risk score",
    };
  }
}

/**
 * Synchronous fallback for backward compatibility in the pipeline.
 */
export function evaluateThreat(request: GovernanceRequest): StageResult {
  const detector = new HeuristicThreatDetector();
  // Run heuristics synchronously by extracting the pattern matching logic
  const textFields = [
    request.transaction.product,
    request.transaction.vendor,
    request.transaction.category ?? "",
    JSON.stringify(request.transaction.metadata ?? {}),
  ].join(" ");

  let score = 0;
  for (const pattern of HeuristicThreatDetector["SUSPICIOUS_PATTERNS"]) {
    if (pattern.test(textFields)) {
      score = Math.max(score, 0.9);
      break;
    }
  }
  for (const pattern of HeuristicThreatDetector["SUSPICIOUS_VENDOR_PATTERNS"]) {
    if (pattern.test(request.transaction.vendor)) {
      score = Math.max(score, 0.7);
      break;
    }
  }
  if (request.transaction.amount >= 1000 && request.transaction.amount % 1000 === 0) {
    score = Math.max(score, 0.2);
  }
  if (request.transaction.amount >= 10000) {
    score = Math.max(score, 0.3);
  }

  return {
    stage: "threat-detection",
    passed: score < THREAT_FLAG_THRESHOLD,
    score: Math.round(score * 1000) / 1000,
    blocked: score >= THREAT_BLOCK_THRESHOLD,
    explanation:
      score > 0
        ? `Heuristic threat score: ${(score * 100).toFixed(1)}%`
        : "No threats detected",
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function tokenizeSimple(text: string, maxLength: number): number[] {
  const tokens: number[] = [];
  for (let i = 0; i < Math.min(text.length, maxLength); i++) {
    tokens.push(text.charCodeAt(i));
  }
  while (tokens.length < maxLength) {
    tokens.push(0);
  }
  return tokens;
}
