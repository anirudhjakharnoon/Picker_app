import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { runTick } from "@/lib/crawlEngine";
import { isAuthorizedInternalRequest } from "@/lib/internalAuth";
import { getSiteUrl } from "@/lib/supabase/env";
import { TICK_MAX_DURATION_SECONDS } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel Hobby caps Node serverless functions at 60s; Pro/Enterprise allow
// more. 60 is the number that works on every plan - see lib/constants.ts
// for the full rationale (TICK_MAX_DURATION_SECONDS).
export const maxDuration = TICK_MAX_DURATION_SECONDS;

export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const summary = await runTick(supabase, params.id, getSiteUrl());
  return NextResponse.json(summary, { status: 200 });
}
