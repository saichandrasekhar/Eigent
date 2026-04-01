"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const error = searchParams.get("error");

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-10 h-10 bg-accent rounded-xl flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="font-display font-bold text-2xl text-text-primary tracking-tight">
            eigent<span className="text-accent">.</span>
          </span>
        </div>

        <div className="bg-bg-card rounded-xl border border-border p-8">
          <h1 className="font-display font-bold text-lg text-text-primary text-center mb-2">
            Sign in to continue
          </h1>
          <p className="text-text-muted text-xs font-mono text-center mb-6">
            Agent Trust Dashboard
          </p>

          {error && (
            <div className="bg-severity-critical/10 border border-severity-critical/30 rounded-lg p-3 mb-4">
              <p className="text-severity-critical text-xs font-mono">
                {error === "OAuthSignin" && "Error starting sign in flow."}
                {error === "OAuthCallback" && "Error during sign in callback."}
                {error === "OAuthAccountNotLinked" && "Account is linked to another provider."}
                {error === "Callback" && "Sign in callback error."}
                {!["OAuthSignin", "OAuthCallback", "OAuthAccountNotLinked", "Callback"].includes(error) && "An error occurred during sign in."}
              </p>
            </div>
          )}

          <button
            onClick={() => signIn("oidc", { callbackUrl })}
            className="w-full bg-accent hover:bg-accent/90 text-white rounded-lg px-4 py-3 text-sm font-display font-semibold transition-colors flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2l8 4v6c0 5.5-3.8 10.7-8 12-4.2-1.3-8-6.5-8-12V6l8-4z" />
            </svg>
            Sign in with SSO
          </button>

          <p className="text-text-muted text-[0.6rem] font-mono text-center mt-4">
            Authentication via your organization&apos;s identity provider
          </p>
        </div>

        <p className="text-text-muted text-[0.55rem] font-mono text-center mt-6">
          Eigent Agent Trust Infrastructure
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <div className="text-text-muted text-sm font-mono">Loading...</div>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
