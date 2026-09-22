import { NextResponse } from "next/server";
import { createRouteHandlerClient, createServiceRoleClient, getSessionUserId } from "@/lib/supabase/server";
import { EXPORTS_BUCKET, EXPORT_SIGNED_URL_TTL_SECONDS } from "@/lib/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }): Promise<Response> {
  const routeClient = createRouteHandlerClient();
  const userId = await getSessionUserId(routeClient);
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  // RLS scopes this read to the caller's own job.
  const { data: job } = await routeClient
    .from("crawl_jobs")
    .select("md_storage_path")
    .eq("id", params.id)
    .maybeSingle();

  if (!job) {
    return NextResponse.json({ error: "Job not found or not yours." }, { status: 404 });
  }
  if (!job.md_storage_path) {
    return NextResponse.json(
      { error: "This job has no export yet - it may still be running." },
      { status: 404 },
    );
  }

  // Storage has no client-facing policies (see migration 0001) - signing
  // always happens server-side with the service role, generated fresh on
  // every call, never cached.
  const serviceClient = createServiceRoleClient();
  const { data: signed, error } = await serviceClient.storage
    .from(EXPORTS_BUCKET)
    .createSignedUrl(job.md_storage_path, EXPORT_SIGNED_URL_TTL_SECONDS);

  if (error || !signed) {
    return NextResponse.json({ error: "Failed to create a download link." }, { status: 500 });
  }

  return NextResponse.json({
    url: signed.signedUrl,
    expiresInSeconds: EXPORT_SIGNED_URL_TTL_SECONDS,
  });
}
