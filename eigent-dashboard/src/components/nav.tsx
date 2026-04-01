"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState } from "react";

const links = [
  { href: "/", label: "Dashboard", icon: GridIcon },
  { href: "/agents", label: "Agents", icon: AgentIcon },
  { href: "/delegation", label: "Delegation", icon: TreeIcon },
  { href: "/audit", label: "Audit", icon: ClipboardIcon },
  { href: "/trace", label: "Trace", icon: TraceIcon },
  { href: "/policies", label: "Policies", icon: RulesIcon },
  { href: "/compliance", label: "Compliance", icon: ShieldIcon },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-bg-primary/80 backdrop-blur-xl border-b border-border">
      <div className="max-w-7xl mx-auto px-6 flex items-center h-14">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 mr-10">
          <div className="w-7 h-7 bg-accent rounded-lg flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="font-display font-bold text-text-primary tracking-tight">
            eigent<span className="text-accent">.</span>
          </span>
        </Link>

        {/* Links */}
        <div className="flex items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`
                  flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-display
                  transition-colors duration-150
                  ${active
                    ? "bg-accent/10 text-accent"
                    : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
                  }
                `}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </Link>
            );
          })}
        </div>

        {/* Right side */}
        <div className="ml-auto flex items-center gap-3">
          <RegistryStatus />
          <span className="text-text-muted text-[0.65rem] font-mono bg-bg-card px-2.5 py-1 rounded-md border border-border">
            v0.3.0
          </span>
          <UserMenu />
        </div>
      </div>
    </nav>
  );
}

function RegistryStatus() {
  return (
    <div className="flex items-center gap-1.5 text-[0.65rem] font-mono text-text-muted bg-bg-card px-2.5 py-1 rounded-md border border-border">
      <span className="w-1.5 h-1.5 rounded-full bg-status-pass animate-pulse" />
      Registry
    </div>
  );
}

const roleBadgeColors: Record<string, string> = {
  admin: "bg-severity-critical/10 text-severity-critical",
  operator: "bg-accent/10 text-accent",
  viewer: "bg-status-pass/10 text-status-pass",
};

function UserMenu() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);

  if (!session?.user) {
    return null;
  }

  const role = (session.user as Record<string, unknown>).role as string ?? "viewer";
  const badgeColor = roleBadgeColors[role] ?? roleBadgeColors.viewer;
  const initials = (session.user.name ?? session.user.email ?? "?")
    .split(/[\s@]/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-bg-card border border-border rounded-lg px-2.5 py-1 hover:border-accent/40 transition-colors"
      >
        <div className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center">
          <span className="text-accent text-[0.5rem] font-mono font-bold">{initials}</span>
        </div>
        <span className="text-text-secondary text-[0.65rem] font-mono max-w-[120px] truncate">
          {session.user.email}
        </span>
        <span className={`text-[0.55rem] font-mono px-1.5 py-0.5 rounded-full ${badgeColor}`}>
          {role}
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 bg-bg-card border border-border rounded-lg shadow-lg py-1 min-w-[180px]">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-text-primary text-xs font-display font-semibold truncate">
                {session.user.name}
              </p>
              <p className="text-text-muted text-[0.6rem] font-mono truncate">
                {session.user.email}
              </p>
            </div>
            <button
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="w-full text-left px-3 py-2 text-xs font-display text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function AgentIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2" />
    </svg>
  );
}

function TreeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </svg>
  );
}

function ClipboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <line x1="8" y1="10" x2="16" y2="10" />
      <line x1="8" y1="14" x2="12" y2="14" />
    </svg>
  );
}

function RulesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </svg>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2l8 4v6c0 5.5-3.8 10.7-8 12-4.2-1.3-8-6.5-8-12V6l8-4z" />
    </svg>
  );
}

function TraceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2v4m0 12v4M2 12h4m12 0h4" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}
