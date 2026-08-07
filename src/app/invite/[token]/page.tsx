import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailsMatch } from "@/lib/assessment";
import { InviteClient } from "./InviteClient";

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

export default async function InvitePage({ params }: { params: { token: string } }) {
  const invitation = await prisma.invitation.findUnique({
    where: { token: params.token },
    include: {
      assessment: {
        include: { problems: { include: { problem: true }, orderBy: { ordinal: "asc" } } },
      },
      session: true,
    },
  });

  if (!invitation) {
    return (
      <DeadLink
        title="Invalid invite link"
        message="This link doesn't match any test invitation. Check that you copied the whole URL."
      />
    );
  }

  const { assessment } = invitation;

  if (invitation.session && invitation.session.state !== "in_progress") {
    return (
      <DeadLink
        title="Test already completed"
        message={`You have already finished "${assessment.title}". Your results have been sent to the hiring team.`}
      />
    );
  }

  // An in-progress session whose clock ran out is finished, whatever the row says.
  if (invitation.session && invitation.session.endsAt.getTime() <= Date.now()) {
    return (
      <DeadLink
        title="Time expired"
        message={`Your time for "${assessment.title}" has run out. Whatever you submitted has been recorded.`}
      />
    );
  }

  if (!invitation.session && invitation.expiresAt.getTime() < Date.now()) {
    return (
      <DeadLink
        title="Invite link expired"
        message={`This link was valid until ${invitation.expiresAt.toLocaleDateString()}. Ask the hiring team for a new one.`}
      />
    );
  }

  // Both of these are reasons not to *begin* a test, so they only apply when
  // there is no session yet — the start endpoint returns a live session before it
  // looks at either. A candidate whose clock is already running must not be
  // locked out of it because the organiser closed the assessment or emptied its
  // question list while they were working; their session carries its own frozen
  // copy of the questions, so it is still playable.
  if (!invitation.session) {
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

  const session = await getServerSession(authOptions);
  const signedInEmail = session?.user?.email ?? null;
  const matched = emailsMatch(signedInEmail, invitation.candidateEmail);

  return (
    <Shell>
      <InviteClient
        token={params.token}
        candidateName={invitation.candidateName}
        candidateEmail={invitation.candidateEmail}
        signedInEmail={signedInEmail}
        matched={matched}
        resuming={!!invitation.session}
        // Describes the assessment as it stands now. For a resuming candidate the
        // session's frozen question set is the one that will actually be served,
        // so if the assessment has been edited since they started, this summary
        // can overstate or understate what is left to answer.
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
