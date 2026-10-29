import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { fw } from "@fireweaveai/server-sdk/start";
import { account, invitation, member, organization as organizationTable, session, user, verification } from "@clinic/db";
import { db } from "./db";
import { env } from "./env";
import { provisionClinic } from "./provision";

function originPair(url: string): string[] {
  const parsed = new URL(url);
  const twin =
    parsed.hostname === "localhost"
      ? parsed.host.replace("localhost", "127.0.0.1")
      : parsed.hostname === "127.0.0.1"
        ? parsed.host.replace("127.0.0.1", "localhost")
        : parsed.host;
  return [...new Set([parsed.origin, `${parsed.protocol}//${twin}`])];
}

export const auth = betterAuth({
  secret: env.authSecret,
  baseURL: env.authUrl,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification, organization: organizationTable, member, invitation },
  }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  plugins: [
    organization({
      organizationHooks: {
        afterCreateOrganization: async ({ organization }) => {
          await provisionClinic(organization.id, organization.name);
        },
      },
    }),
  ],
  trustedOrigins: originPair(env.authUrl),
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      // FireWeave: bind identity wherever a session is established (sign-in, sign-up, OAuth), never
      // inside a control-point branch. See .fireweave/agent-instructions.md, "Identity".
      const newSession = ctx.context.newSession;
      if (!newSession) return;
      const [membership] = await db.select().from(member).where(eq(member.userId, newSession.user.id));
      await fw.identify(newSession.user.id, {
        email: newSession.user.email,
        clinicId: membership?.organizationId ?? null,
        role: membership?.role ?? null,
      });
    }),
  },
});
