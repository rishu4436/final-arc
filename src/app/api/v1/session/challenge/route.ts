import { handleWorkspaceChallenge, liveWorkspaceSessionRuntime } from "@/lib/workspaceSession";
import { sessionResponse } from "../respond";

export const dynamic = "force-dynamic";

/** Server-generated, short-lived, single-use sign-in challenge (EIP-4361 text). */
export async function POST(request: Request) {
  return sessionResponse(await handleWorkspaceChallenge(request, liveWorkspaceSessionRuntime()));
}
