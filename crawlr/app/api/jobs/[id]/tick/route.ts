import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { runTick } from "@/lib/crawlEngine";
import { isAuthorizedInternalRequest } from "@/lib/internalAuth";
import { getSiteUrl } from "@/lib/supabase/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Next.js requires this to be a literal, so it can't reference
// TICK_MAX_DURATION_SECONDS directly - keep this in sync with that
// constant in lib/constants.ts. Vercel Hobby caps Node serverless
// functions at 60s; Pro/Enterprise allow more, but 60 works on every plan.
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const summary = await runTick(supabase, params.id, getSiteUrl());
  return NextResponse.json(summary, { status: 200 });
}
