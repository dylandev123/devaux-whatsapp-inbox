import { NextResponse } from "next/server";
import { jsonError, readJson, requireAdmin } from "@/lib/server/aiAgent/auth";
import { resolveBusinessSlug } from "@/lib/server/aiAgent/db";
import { simulateHistoricalTurn, simulatePilotRequest } from "@/lib/server/aiAgent/decide";

// Admin-only. Re-runs one past customer turn with TODAY's approved knowledge and stores it as a
// SIMULATION (never a historical result). At most one model call; none for turns that already have a
// result, acknowledgements, injection attempts or contacts the agent may not engage with.
// Nothing is queued or sent.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const body = await readJson<{ businessSlug?: unknown; eventId?: unknown; escalationId?: unknown }>(request);
  const businessSlug = await resolveBusinessSlug(body?.businessSlug);
  if (!body || !businessSlug) return jsonError("Unknown businessSlug", 400);
  // Approval Pilot "Test Again": by request (escalation), same guards and hourly limit, stored as a simulation.
  if (typeof body.escalationId === "string") {
    if (!UUID.test(body.escalationId)) return jsonError("escalationId must be a uuid", 400);
    try {
      return NextResponse.json(await simulatePilotRequest({ businessSlug, escalationId: body.escalationId, adminId: admin.userId }));
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : "Simulation failed", 500);
    }
  }
  if (typeof body.eventId !== "string" || !UUID.test(body.eventId)) return jsonError("eventId must be a uuid", 400);
  try {
    return NextResponse.json(await simulateHistoricalTurn({ businessSlug, eventId: body.eventId, adminId: admin.userId }));
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "Simulation failed", 500);
  }
}
