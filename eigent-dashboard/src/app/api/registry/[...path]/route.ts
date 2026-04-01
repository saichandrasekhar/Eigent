import { NextRequest, NextResponse } from "next/server";

const REGISTRY_URL = process.env.EIGENT_REGISTRY_URL || "http://localhost:3456";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await params;
  const targetPath = `/api/${path.join("/")}`;
  const url = new URL(targetPath, REGISTRY_URL);

  // Forward query params
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "Registry unavailable", registry_url: REGISTRY_URL },
      { status: 502 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await params;
  const targetPath = `/api/${path.join("/")}`;
  const url = new URL(targetPath, REGISTRY_URL);

  try {
    const body = await request.json();
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "Registry unavailable", registry_url: REGISTRY_URL },
      { status: 502 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<NextResponse> {
  const { path } = await params;
  const targetPath = `/api/${path.join("/")}`;
  const url = new URL(targetPath, REGISTRY_URL);

  try {
    const res = await fetch(url.toString(), { method: "DELETE" });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "Registry unavailable", registry_url: REGISTRY_URL },
      { status: 502 }
    );
  }
}
