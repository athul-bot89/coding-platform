import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Log anti-cheat events from the client
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { event, detail, attemptId } = await req.json();

  const validEvents = [
    "tab_switch",
    "copy",
    "paste",
    "fullscreen_exit",
    "right_click",
    "devtools",
    "window_blur",
  ];

  if (!event || !validEvents.includes(event)) {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }

  await prisma.proctorEvent.create({
    data: {
      userId: (session.user as any).id,
      attemptId: attemptId || null,
      event,
      detail: detail || null,
    },
  });

  return NextResponse.json({ ok: true });
}
