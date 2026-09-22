import { NextResponse } from "next/server";
import { createRouteHandlerClient, createServiceRoleClient, getSessionUserId } from "@/lib/supabase/server";
import { probeUrl } from "@/lib/probe";
import { buildUserAgent } from "@/lib/constants";
import { getSiteUrl } from "@/lib/supabase/env";
import { isNonEmptyString, isValidScope } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const routeClient = createRouteHandlerClient();
  const userId = await getSessionUserId(routeClient);
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { url, scope } = (body ?? {}) as { url?: unknown; scope?: unknown };
  if (!isNonEmptyString(url)) {
    return NextResponse.json({ error: "Missing or invalid 'url'." }, { status: 400 });
  }
  const effectiveScope = isValidScope(scope) ? scope : "page";

  // robots_cache has no client RLS policy, so probing (which reads/writes
  // it via getRobotsRules) must use the service-role client - the route's
  // own auth check above is what gates who may call this endpoint.
  const serviceClient = createServiceRoleClient();
  const userAgent = buildUserAgent(getSiteUrl());

  const result = await probeUrl(serviceClient, url, effectiveScope, userAgent);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
