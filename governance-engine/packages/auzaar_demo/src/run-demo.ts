import { unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateKeyPair,
  generateRequestId,
  generateTransactionId,
} from "@auzaar/core";
import { EventLogger, JsonFileEventStore } from "@auzaar/event-log";
import { GovernanceEngine, loadPolicyFile } from "@auzaar/governance-engine";
import { InMemoryMandateStore, MandateService } from "@auzaar/mandate-service";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const policyPath = join(packageRoot, "policies", "deterministic_policy.json");
const eventLogPath = join(packageRoot, "event_log.json");

const red = "\x1b[31m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

async function main(): Promise<void> {
  console.log(`
${bold}Step 1 — Deterministic policy (Sarah’s $50 office-supply cap)${reset}
Open this file in your editor:
  ${policyPath}
`);

  try {
    await unlink(eventLogPath);
  } catch (e: unknown) {
    const code =
      e && typeof e === "object" && "code" in e ? (e as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") throw e;
  }

  const keyPair = generateKeyPair();
  const mandateStore = new InMemoryMandateStore();
  const mandateService = new MandateService(mandateStore, keyPair.privateKey);

  const policy = loadPolicyFile(policyPath);
  const eventStore = new JsonFileEventStore(eventLogPath);
  const eventLogger = new EventLogger(eventStore);

  const governanceEngine = new GovernanceEngine({
    policies: [policy],
    eventWriter: eventLogger,
  });

  const userId = "user_procurement";
  const agentId = "agent_onboarding_v1";

  console.log(`
--- ${bold}Step 2 — Mock agent${reset} (threat scenario) ---
Goal: buy a good mechanical keyboard for the new hire.
The agent searched vendors and selected:
  Product: Keychron Q1 Pro (mechanical keyboard)
  Price:   $120.00 USD
  Vendor:  Keychron
  Channel: simulated UCP checkout
`);

  const mandateResult = await mandateService.createMandate(
    userId,
    agentId,
    "Purchase a comfortable mechanical keyboard for the new hire's desk setup.",
    {
      product: "mechanical keyboard",
      maxBudget: 200,
      currency: "USD",
      quantity: 1,
      category: "office_supplies",
    }
  );

  if (!mandateResult.ok) {
    console.error("Failed to create mandate:", mandateResult.error);
    process.exit(1);
  }

  const mandate = mandateResult.value;
  console.log(`Mandate created: ${mandate.id} (maxBudget $200 — policy still caps at $50 per transaction)\n`);

  if (input.isTTY) {
    const rl = createInterface({ input, output });
    await rl.question(
      `${bold}Step 3${reset} — Press Enter to submit the $120 checkout (simulated UCP) through Auzaar…\n`
    );
    rl.close();
  }

  const requestId = generateRequestId();
  const txnId = generateTransactionId();
  const now = new Date().toISOString();

  const request = {
    requestId,
    transaction: {
      id: txnId,
      mandateId: mandate.id,
      agentId,
      userId,
      vendor: "Keychron",
      product: "Keychron Q1 Pro mechanical keyboard",
      category: "office_supplies",
      amount: 120,
      currency: "USD",
      quantity: 1,
      targetProtocol: "ucp" as const,
      timestamp: now,
    },
    mandateId: mandate.id,
    agentId,
    userId,
    timestamp: now,
  };

  await eventLogger.log("transaction_submitted", {
    requestId,
    agentId,
    userId,
    mandateId: mandate.id,
    request,
  });

  const decisionResult = await governanceEngine.evaluate(request, mandate);

  if (!decisionResult.ok) {
    console.error(`${red}${bold}GOVERNANCE ERROR${reset}`, decisionResult.error.message);
    process.exit(1);
  }

  const decision = decisionResult.value;
  const rulesStage = decision.stageResults.find((s) => s.stage === "rules-engine");
  const matchedRules = rulesStage?.matchedRules ?? [];

  if (decision.decision === "blocked") {
    console.log(`
${red}${bold}Step 3 — Interception${reset}
${red}${bold}╔══════════════════════════════════════════════════════════════╗
║  AUZAAR — TRANSACTION BLOCKED (deterministic policy)          ║
╚══════════════════════════════════════════════════════════════╝${reset}
${red}Decision:${reset}     blocked
${red}Latency:${reset}      ${decision.latencyMs} ms
${red}Agent:${reset}        ${agentId}
${red}Violated rule:${reset} ${matchedRules.join(", ") || "(see explanation)"}
${red}Explanation:${reset}  ${decision.explanation}
`);
  } else {
    console.log("Decision:", decision.decision, decision.explanation);
  }

  const agentPayload = {
    requestId,
    transactionId: txnId,
    decision: decision.decision,
    compositeScore: decision.compositeScore,
    explanation: decision.explanation,
    latencyMs: decision.latencyMs,
    matchedRules,
    safeFailure:
      decision.decision === "blocked"
        ? {
            ok: false,
            code: "POLICY_VIOLATION",
            message: "Transaction was not released to the commerce protocol.",
          }
        : undefined,
  };

  console.log("--- Response to agent (JSON) ---\n");
  console.log(JSON.stringify(agentPayload, null, 2));
  console.log(`
--- ${bold}Step 4 — Audit trail${reset} ---
Written to: ${eventLogPath}
Open this file, or refresh the dashboard ${bold}Audit Log${reset} (http://localhost:3200/audit) — same data: hash chain, timestamps, agentId, violated rule ids on governance_decided.
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
