import { fetchAuditLog } from "@/lib/registry";
import { TraceViewer } from "./trace-viewer";

export default async function TracePage() {
  // Pre-fetch recent audit entries for the search
  const auditResult = await fetchAuditLog({ limit: 100 });

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-display font-bold text-text-primary">Trace Viewer</h1>
        <p className="text-text-muted text-sm mt-1 font-display">
          Trace delegation chains, token issuance, and enforcement decisions for any audit event
        </p>
      </div>

      <TraceViewer initialEntries={auditResult.entries} />
    </div>
  );
}
