import {
  type StructuredIntent,
  StructuredIntentSchema,
  type Result,
  ok,
  err,
  AuzaarError,
} from "@auzaar/core";

export function parseIntent(
  _intentText: string,
  structuredFields: Partial<StructuredIntent>
): Result<StructuredIntent> {
  const parsed = StructuredIntentSchema.safeParse(structuredFields);

  if (!parsed.success) {
    const details: Record<string, unknown> = {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
    return err(
      new AuzaarError(
        `Invalid structured intent: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
        "INTENT_PARSE_ERROR",
        details
      )
    );
  }

  return ok(parsed.data);
}
