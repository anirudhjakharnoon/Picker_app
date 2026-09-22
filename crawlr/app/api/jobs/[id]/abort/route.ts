import { NextResponse } from "next/server";
import { createRouteHandlerClient, getSessionUserId } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: { id: string } }): Promise<Response> {
  const routeClient = createRouteHandlerClient();
  const userId = await getSessionUserId(routeClient);
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  // RLS (owner = auth.uid()) already scopes this to the caller's own job;
  // restricting to status='running' here makes it a no-op on an already
  // finished job instead of clobbering a terminal status.
  const { data, error } = await routeClient
    .from("crawl_jobs")
    .update({ status: "aborted", finished_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("status", "running")
    .select()
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Failed to abort job." }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { error: "Job not found, not yours, or already finished." },
      { status: 404 },
    );
  }

  return NextResponse.json({ id: params.id, status: "aborted" }, { status: 200 });
}
