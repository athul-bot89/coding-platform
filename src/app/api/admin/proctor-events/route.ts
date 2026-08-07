import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, paginationParams } from "@/lib/admin-guard";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("userId");
  const { page, limit, skip } = paginationParams(searchParams, {
    defaultLimit: 50,
    maxLimit: 200,
  });

  const where = userId ? { userId } : {};

  const [events, total] = await Promise.all([
    prisma.proctorEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.proctorEvent.count({ where }),
  ]);

  return NextResponse.json({
    events,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}
