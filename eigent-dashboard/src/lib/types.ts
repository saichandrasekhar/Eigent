import { z } from "zod";

// Schema for incoming scan results from eigent-scan CLI
export const AgentResultSchema = z.object({
  name: z.string(),
  source: z.string(),
  transport: z.string().default("unknown"),
  auth_status: z.string().default("unknown"),
  config_path: z.string().optional(),
  command: z.string().optional(),
});

export const FindingResultSchema = z.object({
  agent_name: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  title: z.string(),
  description: z.string(),
  recommendation: z.string().default(""),
  category: z.string().optional(),
});

export const ScanResultSchema = z.object({
  scan_id: z.string().optional(),
  timestamp: z.string().optional(),
  targets: z.array(z.string()).default([]),
  agents: z.array(AgentResultSchema).default([]),
  findings: z.array(FindingResultSchema).default([]),
  risk_level: z.enum(["critical", "high", "medium", "low", "clean", "unknown"]).default("unknown"),
  org_id: z.string().optional(),
});

export type ScanResult = z.infer<typeof ScanResultSchema>;
export type AgentResult = z.infer<typeof AgentResultSchema>;
export type FindingResult = z.infer<typeof FindingResultSchema>;

// Dashboard types
export interface DashboardStats {
  totalAgents: number;
  noAuth: number;
  criticalFindings: number;
  shadowAgents: number;
}

export interface RiskTrendPoint {
  scanId: string;
  timestamp: string;
  totalFindings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}
