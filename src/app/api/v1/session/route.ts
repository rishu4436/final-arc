import {
  handleWorkspaceLogin,
  handleWorkspaceLogout,
  handleWorkspaceSessionStatus,
  liveWorkspaceSessionRuntime,
} from "@/lib/workspaceSession";
import { sessionResponse } from "./respond";

export const dynamic = "force-dynamic";

/** Current workspace session for this browser (no wallet interaction). */
export async function GET(request: Request) {
  return sessionResponse(await handleWorkspaceSessionStatus(request, liveWorkspaceSessionRuntime()));
}

/** Exchange one signed sign-in challenge for a short-lived HttpOnly session cookie. */
export async function POST(request: Request) {
  return sessionResponse(await handleWorkspaceLogin(request, liveWorkspaceSessionRuntime()));
}

/** Sign out: invalidate the server session and clear the cookie. */
export async function DELETE(request: Request) {
  return sessionResponse(await handleWorkspaceLogout(request, liveWorkspaceSessionRuntime()));
}
