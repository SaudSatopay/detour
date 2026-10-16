import { NextResponse, type NextRequest } from "next/server";
import { isVisitorId, newVisitorId, VISITOR_COOKIE, VISITOR_MAX_AGE } from "./lib/graph/names";

/**
 * Gives a new visitor their id before any route runs. A first page load fires several API calls at
 * once (sandbox state, an auto-started run); without this each would mint its own id and the run and
 * its approval could land in different sandboxes. The id is forwarded on this request and set on the
 * response.
 */
export function proxy(request: NextRequest) {
  const existing = request.cookies.get(VISITOR_COOKIE)?.value;
  if (existing && isVisitorId(existing)) return NextResponse.next();
  const id = newVisitorId();
  const headers = new Headers(request.headers);
  const cookie = request.headers.get("cookie");
  headers.set("cookie", `${cookie ? `${cookie}; ` : ""}${VISITOR_COOKIE}=${id}`);
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set(VISITOR_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: VISITOR_MAX_AGE,
    path: "/",
  });
  return response;
}

export const config = {
  // Pages and API routes; not build assets, the map data or the favicon.
  matcher: ["/((?!_next/static|_next/image|map/|favicon.ico|robots.txt|sitemap.xml|opengraph-image).*)"],
};
