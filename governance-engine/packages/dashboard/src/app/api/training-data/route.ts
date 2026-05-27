import { NextResponse } from "next/server";
import { trainingDataFormatter } from "@/lib/store";

export async function GET(): Promise<NextResponse> {
  const examples = await trainingDataFormatter.exportForFineTuning();
  const count = await trainingDataFormatter.getDatasetSize();

  return NextResponse.json({ count, examples });
}
