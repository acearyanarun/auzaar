import { NextResponse } from "next/server";
import { PolicySchema } from "@auzaar/core";
import { parse as parseYaml } from "yaml";
import { policies } from "@/lib/store";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(policies);
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as { yaml: string };

  if (!body.yaml) {
    return NextResponse.json(
      { error: "yaml field is required" },
      { status: 400 }
    );
  }

  try {
    const parsed = parseYaml(body.yaml);
    const result = PolicySchema.safeParse(parsed);

    if (!result.success) {
      return NextResponse.json(
        {
          valid: false,
          errors: result.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ valid: true, policy: result.data });
  } catch (e) {
    return NextResponse.json(
      {
        valid: false,
        errors: [
          {
            path: "",
            message:
              e instanceof Error ? e.message : "Invalid YAML",
          },
        ],
      },
      { status: 400 }
    );
  }
}
