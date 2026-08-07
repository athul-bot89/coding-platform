import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { StartClient } from "./StartClient";

export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white px-4">
      <div className="w-full max-w-xl">{children}</div>
    </div>
  );
}

function DeadLink({ title, message }: { title: string; message: string }) {
  return (
    <Shell>
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-8 text-center">
        <div className="text-4xl mb-4">🔒</div>
        <h1 className="text-xl font-semibold mb-2">{title}</h1>
        <p className="text-sm text-gray-400">{message}</p>
        <p className="text-xs text-gray-600 mt-6">
          If you believe this is a mistake, reply to the email you received.
        </p>
      </div>
    </Shell>
  );
}

export default async function TestLinkPage({ params }: { params: { token: string } }) {
  const assessment = await prisma.assessment.findUnique({
    where: { joinToken: params.token },
    include: { problems: { include: { problem: true }, orderBy: { ordinal: "asc" } } },
  });

  if (!assessment) {
    return (
      <DeadLink
        title="Invalid test link"
        message="This link doesn't match any test. Check that you copied the whole URL."
      />
    );
  }

  const auth = await getServerSession(authOptions);
  const signedInEmail = auth?.user?.email ?? null;
  const userId = (auth?.user as any)?.id as string | undefined;

  // Only a signed-in visitor can have a session, so this is the one place the
  // page needs the account before it can decide what to show.
  const mine = userId
    ? await prisma.testSession.findUnique({
        where: { assessmentId_userId: { assessmentId: assessment.id, userId } },
      })
    : null;

  if (mine && mine.state !== "in_progress") {
    return (
      <DeadLink
        title="Test already completed"
        message={`You have already finished "${assessment.title}". Your results have been sent to the hiring team.`}
      />
    );
  }

  // An in-progress session whose clock ran out is finished, whatever the row says.
  if (mine && mine.endsAt.getTime() <= Date.now()) {
    return (
      <DeadLink
        title="Time expired"
        message={`Your time for "${assessment.title}" has run out. Whatever you submitted has been recorded.`}
      />
    );
  }

  // Both of these are reasons not to *begin* a test, so they only apply when
  // there is no session yet. A candidate whose clock is already running must not
  // be locked out of it because the organiser closed the test or emptied its
  // question list while they were working; their session carries its own frozen
  // copy of the questions, so it is still playable.
  if (!mine) {
    if (!assessment.isActive) {
      return (
        <DeadLink title="Test unavailable" message="This test has been closed by the organiser." />
      );
    }

    if (assessment.problems.length === 0) {
      return (
        <DeadLink
          title="Test not ready"
          message="This test has no questions yet. Please check back shortly."
        />
      );
    }
  }

  return (
    <Shell>
      <StartClient
        token={params.token}
        signedInEmail={signedInEmail}
        signedInName={auth?.user?.name ?? null}
        resuming={!!mine}
        // Describes the test as it stands now. For a resuming candidate the
        // session's frozen question set is the one that will actually be served,
        // so if the test has been edited since they started, this summary can
        // overstate or understate what is left to answer.
        assessment={{
          title: assessment.title,
          instructions: assessment.instructions,
          durationMinutes: assessment.durationMinutes,
          maxViolations: assessment.maxViolations,
          questionCount: assessment.problems.length,
          totalPoints: assessment.problems.reduce((s, p) => s + p.points, 0),
          problems: assessment.problems.map((ap) => ({
            title: ap.problem.title,
            difficulty: ap.problem.difficulty,
            points: ap.points,
          })),
        }}
      />
    </Shell>
  );
}
