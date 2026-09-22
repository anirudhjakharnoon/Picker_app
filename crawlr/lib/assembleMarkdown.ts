/**
 * Assembles every crawled page's Markdown into the single .md document
 * uploaded to Storage at job completion: a top-level header (source URL,
 * crawl date, scope) followed by one `## <title>` section per page.
 */

export interface AssembleMarkdownJob {
  target_url: string;
  scope: string;
  created_at: string;
}

export interface AssembleMarkdownPage {
  url: string;
  title: string | null;
  markdown: string | null;
}

const SCOPE_LABELS: Record<string, string> = {
  page: "This page only",
  linked: "This page + its linked pages",
  site: "Entire website (capped)",
};

export function assembleMarkdownDocument(
  job: AssembleMarkdownJob,
  pages: AssembleMarkdownPage[],
): string {
  const crawledDate = new Date(job.created_at).toISOString().slice(0, 10);
  const scopeLabel = SCOPE_LABELS[job.scope] ?? job.scope;

  const header = [
    "# CRAWLR Export",
    "",
    `- **Source:** ${job.target_url}`,
    `- **Crawl date:** ${crawledDate}`,
    `- **Scope:** ${scopeLabel}`,
    `- **Pages included:** ${pages.length}`,
    "",
    "---",
  ].join("\n");

  const sections = pages.map((page) => {
    const title = page.title?.trim() || page.url;
    const body = page.markdown?.trim() || "*(no text content extracted)*";
    return [`## ${title}`, "", `Source: ${page.url}`, "", body].join("\n");
  });

  return [header, ...sections].join("\n\n---\n\n") + "\n";
}
