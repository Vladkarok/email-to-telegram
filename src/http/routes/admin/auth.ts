import { timingSafeEqual, randomBytes } from "crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

export interface AdminSession {
  authenticated?: boolean;
  loginAt?: number;
  csrfToken?: string;
}

declare module "fastify" {
  interface Session {
    admin?: AdminSession;
  }
}

export function verifyAdminSecret(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    const padded = Buffer.alloc(b.length);
    a.copy(padded);
    return timingSafeEqual(padded, b) && false;
  }
  return timingSafeEqual(a, b);
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

export function isAdminAuthenticated(req: FastifyRequest, sessionTtlMinutes: number): boolean {
  const admin = req.session?.admin;
  if (!admin?.authenticated || !admin.loginAt) return false;
  const elapsed = Date.now() - admin.loginAt;
  return elapsed < sessionTtlMinutes * 60 * 1000;
}

export function verifyCsrfToken(req: FastifyRequest): boolean {
  const sessionToken = req.session?.admin?.csrfToken;
  if (!sessionToken) return false;
  const body = req.body as Record<string, unknown> | undefined;
  const submittedToken = body?.["_csrf"] as string | undefined;
  if (!submittedToken) return false;
  return verifyAdminSecret(submittedToken, sessionToken);
}

export function requireAdmin(
  sessionTtlMinutes: number,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!isAdminAuthenticated(req, sessionTtlMinutes)) {
      await reply.redirect("/admin/login");
    }
  };
}
