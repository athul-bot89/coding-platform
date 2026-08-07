import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if ((session.user as any).role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const problems = await prisma.problem.findMany({
    where: { isActive: true },
    select: {
      id: true,
      title: true,
      slug: true,
      difficulty: true,
      allowedLanguages: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(problems);
}
