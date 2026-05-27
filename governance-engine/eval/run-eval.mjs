/**
 * Eval runner for Auzaar threat detection and intent alignment.
 * Runs detectors against labeled datasets and reports precision/recall/F1.
 *
 * Usage: node eval/run-eval.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HeuristicThreatDetector,
  evaluateAlignment,
} from "../packages/governance-engine/dist/index.js";
import { generateRequestId, generateTransactionId } from "../packages/core/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const THREAT_THRESHOLD = 0.5;
const ALIGNMENT_THRESHOLD = 0.4;

async function runThreatEval() {
  const datasetPath = resolve(__dirname, "datasets/threat-eval.json");
  const dataset = JSON.parse(readFileSync(datasetPath, "utf-8"));
  const examples = dataset.examples;

  const detector = new HeuristicThreatDetector();
  const matrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const categoryResults = new Map();
  const details = [];

  for (const ex of examples) {
    const score = await detector.classify({
      vendor: ex.vendor,
      product: ex.product,
      amount: ex.amount,
      category: undefined,
      agentId: "eval-agent",
      intentText: ex.agentContext,
      transactionContext: ex.agentContext,
    });

    const predicted = score >= THREAT_THRESHOLD ? "threat" : "benign";
    const expected = ex.label;

    details.push({ id: ex.id, category: ex.category, expected, predicted, score });

    if (predicted === "threat" && expected === "threat") matrix.tp++;
    else if (predicted === "threat" && expected === "benign") matrix.fp++;
    else if (predicted === "benign" && expected === "threat") matrix.fn++;
    else matrix.tn++;

    if (!categoryResults.has(ex.category)) {
      categoryResults.set(ex.category, { tp: 0, fp: 0, fn: 0, tn: 0 });
    }
    const cat = categoryResults.get(ex.category);
    if (predicted === "threat" && expected === "threat") cat.tp++;
    else if (predicted === "threat" && expected === "benign") cat.fp++;
    else if (predicted === "benign" && expected === "threat") cat.fn++;
    else cat.tn++;
  }

  const precision = matrix.tp / (matrix.tp + matrix.fp) || 0;
  const recall = matrix.tp / (matrix.tp + matrix.fn) || 0;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;

  const perCategory = [];
  for (const [category, cm] of categoryResults) {
    const p = cm.tp / (cm.tp + cm.fp) || 0;
    const r = cm.tp / (cm.tp + cm.fn) || 0;
    const f = (2 * p * r) / (p + r) || 0;
    perCategory.push({
      category,
      precision: round(p),
      recall: round(r),
      f1: round(f),
      support: cm.tp + cm.fn + cm.fp + cm.tn,
    });
  }

  return {
    overall: { precision: round(precision), recall: round(recall), f1: round(f1) },
    perCategory,
    matrix,
    details,
  };
}

async function runAlignmentEval() {
  const datasetPath = resolve(__dirname, "datasets/alignment-eval.json");
  const dataset = JSON.parse(readFileSync(datasetPath, "utf-8"));
  const examples = dataset.examples;

  const details = [];
  const labelResults = new Map();
  const overallMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };

  for (const ex of examples) {
    const now = new Date().toISOString();
    const request = {
      requestId: generateRequestId(),
      transaction: {
        id: generateTransactionId(),
        mandateId: "eval-mandate",
        agentId: "eval-agent",
        userId: "eval-user",
        vendor: ex.transaction.vendor,
        product: ex.transaction.product,
        amount: ex.transaction.amount,
        currency: "USD",
        quantity: 1,
        category: ex.transaction.category,
        timestamp: now,
      },
      mandateId: "eval-mandate",
      agentId: "eval-agent",
      userId: "eval-user",
      timestamp: now,
    };

    const mandateContext = {
      intentText: ex.mandate.intentText,
      structuredIntent: {
        product: ex.mandate.product,
        maxBudget: ex.mandate.maxBudget,
        category: ex.mandate.category,
        quantity: ex.mandate.quantity,
        vendorPreferences: ex.mandate.vendorPreferences,
      },
    };

    const result = evaluateAlignment(request, mandateContext);
    const alignmentScore = 1 - result.score;

    let predicted;
    if (alignmentScore >= ALIGNMENT_THRESHOLD) {
      predicted = "aligned";
    } else if (alignmentScore >= 0.15) {
      predicted = "partial_drift";
    } else {
      predicted = "full_drift";
    }

    details.push({ id: ex.id, label: ex.label, predicted, alignmentScore: round(alignmentScore) });

    const isDriftExpected = ex.label === "full_drift";
    const isDriftPredicted = predicted === "full_drift";

    if (isDriftPredicted && isDriftExpected) overallMatrix.tp++;
    else if (isDriftPredicted && !isDriftExpected) overallMatrix.fp++;
    else if (!isDriftPredicted && isDriftExpected) overallMatrix.fn++;
    else overallMatrix.tn++;

    if (!labelResults.has(ex.label)) {
      labelResults.set(ex.label, { tp: 0, fp: 0, fn: 0, tn: 0 });
    }
    const lm = labelResults.get(ex.label);
    if (predicted === ex.label) lm.tp++;
    else lm.fn++;
  }

  const precision = overallMatrix.tp / (overallMatrix.tp + overallMatrix.fp) || 0;
  const recall = overallMatrix.tp / (overallMatrix.tp + overallMatrix.fn) || 0;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;

  const perLabel = [];
  for (const [label, cm] of labelResults) {
    const total = cm.tp + cm.fn;
    const accuracy = total > 0 ? cm.tp / total : 0;
    perLabel.push({
      category: label,
      precision: round(accuracy),
      recall: round(accuracy),
      f1: round(accuracy),
      support: total,
    });
  }

  return {
    overall: { precision: round(precision), recall: round(recall), f1: round(f1) },
    perLabel,
    details,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

function formatTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const sep = widths.map((w) => "-".repeat(w + 2)).join("|");
  const header = headers.map((h, i) => ` ${h.padEnd(widths[i])} `).join("|");
  const body = rows
    .map((row) => row.map((c, i) => ` ${c.padEnd(widths[i])} `).join("|"))
    .join("\n");
  return `|${header}|\n|${sep}|\n${body.split("\n").map((l) => `|${l}|`).join("\n")}`;
}

async function main() {
  console.log("=== Auzaar Eval Runner ===\n");

  console.log("--- Threat Detection Eval ---");
  const threatResults = await runThreatEval();
  console.log(`Overall: P=${threatResults.overall.precision} R=${threatResults.overall.recall} F1=${threatResults.overall.f1}`);
  console.log(`Confusion: TP=${threatResults.matrix.tp} FP=${threatResults.matrix.fp} FN=${threatResults.matrix.fn} TN=${threatResults.matrix.tn}`);
  console.log("\nPer-category:");
  console.log(
    formatTable(
      ["Category", "Precision", "Recall", "F1", "Support"],
      threatResults.perCategory.map((c) => [
        c.category,
        String(c.precision),
        String(c.recall),
        String(c.f1),
        String(c.support),
      ])
    )
  );

  const missedThreats = threatResults.details.filter(
    (d) => d.expected === "threat" && d.predicted === "benign"
  );
  if (missedThreats.length > 0) {
    console.log("\nMissed threats (FN):");
    for (const m of missedThreats) {
      console.log(`  ${m.id} [${m.category}] score=${m.score}`);
    }
  }

  const falseAlarms = threatResults.details.filter(
    (d) => d.expected === "benign" && d.predicted === "threat"
  );
  if (falseAlarms.length > 0) {
    console.log("\nFalse alarms (FP):");
    for (const m of falseAlarms) {
      console.log(`  ${m.id} [${m.category}] score=${m.score}`);
    }
  }

  console.log("\n--- Intent Alignment Eval ---");
  const alignResults = await runAlignmentEval();
  console.log(`Overall drift detection: P=${alignResults.overall.precision} R=${alignResults.overall.recall} F1=${alignResults.overall.f1}`);
  console.log("\nPer-label accuracy:");
  console.log(
    formatTable(
      ["Label", "Accuracy", "Support"],
      alignResults.perLabel.map((c) => [c.category, String(c.precision), String(c.support)])
    )
  );

  const misclassified = alignResults.details.filter((d) => d.label !== d.predicted);
  if (misclassified.length > 0) {
    console.log("\nMisclassified:");
    for (const m of misclassified) {
      console.log(`  ${m.id}: expected=${m.label} predicted=${m.predicted} alignment=${m.alignmentScore}`);
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    threat: threatResults,
    alignment: alignResults,
  };

  const resultsDir = resolve(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const reportPath = join(resultsDir, `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nResults saved to: ${reportPath}`);

  const markdownReport = generateMarkdownReport(threatResults, alignResults);
  const mdPath = join(resultsDir, "LATEST.md");
  writeFileSync(mdPath, markdownReport);
  console.log(`Markdown report: ${mdPath}`);
}

function generateMarkdownReport(threat, alignment) {
  return `# Auzaar Eval Report

Generated: ${new Date().toISOString()}

## Threat Detection (Heuristic)

| Metric | Value |
|--------|-------|
| Precision | ${threat.overall.precision} |
| Recall | ${threat.overall.recall} |
| F1 | ${threat.overall.f1} |

### Confusion Matrix

|  | Predicted Threat | Predicted Benign |
|--|-----------------|-----------------|
| Actual Threat | ${threat.matrix.tp} (TP) | ${threat.matrix.fn} (FN) |
| Actual Benign | ${threat.matrix.fp} (FP) | ${threat.matrix.tn} (TN) |

### Per-Category

| Category | Precision | Recall | F1 | Support |
|----------|-----------|--------|----|---------|
${threat.perCategory.map((c) => `| ${c.category} | ${c.precision} | ${c.recall} | ${c.f1} | ${c.support} |`).join("\n")}

## Intent Alignment (Structural + TF-IDF)

| Metric | Value |
|--------|-------|
| Drift Detection Precision | ${alignment.overall.precision} |
| Drift Detection Recall | ${alignment.overall.recall} |
| Drift Detection F1 | ${alignment.overall.f1} |

### Per-Label Accuracy

| Label | Accuracy | Support |
|-------|----------|---------|
${alignment.perLabel.map((c) => `| ${c.category} | ${c.precision} | ${c.support} |`).join("\n")}
`;
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
