import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";

export type UserRole = "admin" | "operator" | "viewer";

export interface EigentSession {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string;
    role: UserRole;
  };
}

/**
 * Get the current user session. Returns null if not authenticated.
 */
export async function getSession(): Promise<EigentSession | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return null;
  }

  return {
    user: {
      id: (session.user as Record<string, unknown>).id as string ?? session.user.email,
      name: session.user.name ?? session.user.email,
      email: session.user.email,
      image: session.user.image ?? undefined,
      role: ((session.user as Record<string, unknown>).role as UserRole) ?? "viewer",
    },
  };
}

/**
 * Require authentication. Redirects to login if not authenticated.
 */
export async function requireAuth(): Promise<EigentSession> {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

/**
 * Require a minimum role level. Throws if insufficient permissions.
 * Role hierarchy: admin > operator > viewer
 */
export async function requireRole(minimumRole: UserRole): Promise<EigentSession> {
  const session = await requireAuth();

  const roleHierarchy: Record<UserRole, number> = {
    viewer: 0,
    operator: 1,
    admin: 2,
  };

  const userLevel = roleHierarchy[session.user.role];
  const requiredLevel = roleHierarchy[minimumRole];

  if (userLevel < requiredLevel) {
    throw new Error(
      `Insufficient permissions. Required: ${minimumRole}, current: ${session.user.role}`,
    );
  }

  return session;
}

/**
 * Check if the current user has at least the specified role.
 */
export function hasRole(userRole: UserRole, minimumRole: UserRole): boolean {
  const roleHierarchy: Record<UserRole, number> = {
    viewer: 0,
    operator: 1,
    admin: 2,
  };

  return roleHierarchy[userRole] >= roleHierarchy[minimumRole];
}

/**
 * Get role display properties.
 */
export function getRoleBadge(role: UserRole): { label: string; color: string } {
  switch (role) {
    case "admin":
      return { label: "Admin", color: "bg-severity-critical/10 text-severity-critical" };
    case "operator":
      return { label: "Operator", color: "bg-accent/10 text-accent" };
    case "viewer":
      return { label: "Viewer", color: "bg-status-pass/10 text-status-pass" };
  }
}
