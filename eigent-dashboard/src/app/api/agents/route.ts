import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    // Get all agents, grouped by name to show unique agents with latest info
    const agents = await prisma.agent.findMany({
      orderBy: { lastSeen: "desc" },
      include: {
        scan: {
          select: {
            id: true,
            timestamp: true,
            riskLevel: true,
          },
        },
      },
    });

    // Deduplicate by name, keeping the most recent entry
    const agentMap = new Map<
      string,
      {
        name: string;
        source: string;
        transport: string;
        auth_status: string;
        config_path: string | null;
        command: string | null;
        first_seen: string;
        last_seen: string;
        scan_count: number;
        latest_scan_id: string;
        latest_risk_level: string;
      }
    >();

    for (const agent of agents) {
      const existing = agentMap.get(agent.name);
      if (existing) {
        existing.scan_count += 1;
        if (new Date(agent.firstSeen) < new Date(existing.first_seen)) {
          existing.first_seen = agent.firstSeen.toISOString();
        }
      } else {
        agentMap.set(agent.name, {
          name: agent.name,
          source: agent.source,
          transport: agent.transport,
          auth_status: agent.authStatus,
          config_path: agent.configPath,
          command: agent.command,
          first_seen: agent.firstSeen.toISOString(),
          last_seen: agent.lastSeen.toISOString(),
          scan_count: 1,
          latest_scan_id: agent.scan.id,
          latest_risk_level: agent.scan.riskLevel,
        });
      }
    }

    return NextResponse.json({
      agents: Array.from(agentMap.values()),
      total: agentMap.size,
    });
  } catch (error) {
    console.error("Failed to fetch agents:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
