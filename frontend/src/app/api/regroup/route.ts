import { ensureSchema } from "@/db";
import { regroupLibrary } from "@/lib/grouping";
import { goTo } from "@/lib/redirect";

export const runtime = "nodejs";

/** Cluster every face again, which fixes groups that drifted as more photos arrived. */
export async function POST(request: Request) {
  await ensureSchema();
  await regroupLibrary();
  return goTo("/");
}
