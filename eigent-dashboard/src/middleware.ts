export { default } from "next-auth/middleware";

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - api/auth (NextAuth routes)
     * - login page
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico
     */
    "/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)",
  ],
};
