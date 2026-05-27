import { NextResponse } from "next/server";
import { queryService } from "@/lib/store";
import type { EventType } from "@auzaar/core";

export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);

  const filter: {
    eventType?: EventType;
    agentId?: string;
    userId?: string;
    requestId?: string;
    limit?: number;
    offset?: number;
  } = {};

  const eventType = searchParams.get("eventType");
  if (eventType) filter.eventType = eventType as EventType;

  const agentId = searchParams.get("agentId");
  if (agentId) filter.agentId = agentId;

  const userId = searchParams.get("userId");
  if (userId) filter.userId = userId;

  const requestId = searchParams.get("requestId");
  if (requestId) filter.requestId = requestId;

  const limit = searchParams.get("limit");
  if (limit) filter.limit = parseInt(limit, 10);

  const offset = searchParams.get("offset");
  if (offset) filter.offset = parseInt(offset, 10);

  const entries = await queryService.query(filter);
  const sorted = [...entries].sort((a, b) => b.sequenceNumber - a.sequenceNumber);
  return NextResponse.json(sorted);
}
