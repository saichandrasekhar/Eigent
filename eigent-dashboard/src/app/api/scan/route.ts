import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ScanResultSchema } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = ScanResultSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid scan result format",
          details: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Create scan record with related agents and findings
    const scan = await prisma.scan.create({
      data: {
        targets: JSON.stringify(data.targets),
        totalAgents: data.agents.length,
        totalFindings: data.findings.length,
        riskLevel: data.risk_level,
        raw: JSON.stringify(data),
        orgId: data.org_id,
        agents: {
          create: data.agents.map((agent) => ({
            name: agent.name,
            source: agent.source,
            transport: agent.transport,
            authStatus: agent.auth_status,
            configPath: agent.config_path,
            command: agent.command,
          })),
        },
        findings: {
          create: data.findings.map((finding) => ({
            agentName: finding.agent_name,
            severity: finding.severity,
            title: finding.title,
            description: finding.description,
            recommendation: finding.recommendation,
            category: finding.category,
          })),
        },
      },
      include: {
        agents: true,
        findings: true,
      },
    });

    return NextResponse.json(
      {
        scan_id: scan.id,
        timestamp: scan.timestamp.toISOString(),
        agents_count: scan.agents.length,
        findings_count: scan.findings.length,
        risk_level: scan.riskLevel,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Failed to process scan:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const scans = await prisma.scan.findMany({
      orderBy: { timestamp: "desc" },
      take: 50,
      select: {
        id: true,
        timestamp: true,
        totalAgents: true,
        totalFindings: true,
        riskLevel: true,
        orgId: true,
      },
    });

    return NextResponse.json({ scans });
  } catch (error) {
    console.error("Failed to fetch scans:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
