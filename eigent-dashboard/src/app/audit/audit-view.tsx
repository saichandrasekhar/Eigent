"use client";

import { AuditLog } from "@/components/audit-log";

interface AuditEntry {
  id: string;
  timestamp: string;
  agent_id: string;
  human_email: string;
  action: string;
  tool_name: string | null;
  delegation_chain: string[] | null;
  details: Record<string, unknown> | null;
  agent_name?: string;
}

interface AuditPageViewProps {
  entries: AuditEntry[];
}

export function AuditPageView({ entries }: AuditPageViewProps) {
  return (
    <AuditLog entries={entries} showFilters showExport />
  );
}
