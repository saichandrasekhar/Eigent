import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const scan = await prisma.scan.findUnique({
      where: { id },
      include: {
        agents: true,
        findings: {
          orderBy: { severity: "asc" },
        },
      },
    });

    if (!scan) {
      return NextResponse.json(
        { error: "Scan not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id: scan.id,
      timestamp: scan.timestamp.toISOString(),
      targets: JSON.parse(scan.targets),
      total_agents: scan.totalAgents,
      total_findings: scan.totalFindings,
      risk_level: scan.riskLevel,
      org_id: scan.orgId,
      agents: scan.agents.map((a) => ({
        id: a.id,
        name: a.name,
        source: a.source,
        transport: a.transport,
        auth_status: a.authStatus,
        config_path: a.configPath,
        command: a.command,
        first_seen: a.firstSeen.toISOString(),
        last_seen: a.lastSeen.toISOString(),
      })),
      findings: scan.findings.map((f) => ({
        id: f.id,
        agent_name: f.agentName,
        severity: f.severity,
        title: f.title,
        description: f.description,
        recommendation: f.recommendation,
        category: f.category,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch scan:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
