import { NextResponse, type NextRequest } from "next/server";

/**
 * DNS-rebinding guard for the frontend server. In the Docker image it also forwards /api and /files to the backend,
 * which then sees its own internal host name: the browser's Host header has to be checked here.
 * KWEETO_ALLOWED_HOSTS works as in the backend ("*" disables the check). See SECURITY.md.
 */
const ALLOWED = (process.env.KWEETO_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

function hostName(host: string): string {
  const h = host.toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // [::1]:3000
  return h.split(":")[0];
}

export function middleware(request: NextRequest) {
  const host = hostName(request.headers.get("host") ?? "");
  if (ALLOWED.includes("*") || ALLOWED.includes(host)) return NextResponse.next();
  return new NextResponse("Kweeto refuses requests for this host name (see SECURITY.md: KWEETO_ALLOWED_HOSTS).",
    { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
