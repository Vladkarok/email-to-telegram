import type { FastifyInstance } from "fastify";
import { getDb } from "../../db/client.js";
import { verifyBillingAccessToken } from "../../billing/accessTokens.js";
import { BillingCheckoutConflictError, createCheckoutSession } from "../../billing/checkout.js";
import { createCustomerPortalSession } from "../../billing/customerPortal.js";
import { constructWebhookEvent, isStripePriceKey } from "../../billing/stripe.js";
import { processStripeWebhookEvent } from "../../billing/webhooks.js";
import { userHasOrganizationRole } from "../../db/repos/organizationMembers.js";

export function billingRoutes(app: FastifyInstance): void {
  app.post(
    "/billing/checkout",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token, priceKey } = req.body as { token?: string; priceKey?: string };
      const access = verifyBillingAccessToken(token ?? "");
      if (!access) {
        await reply.status(401).send({ error: "invalid token" });
        return;
      }
      if (!priceKey || !isStripePriceKey(priceKey)) {
        await reply.status(400).send({ error: "invalid request" });
        return;
      }
      const allowed = await userHasOrganizationRole(
        getDb(),
        access.organizationId,
        BigInt(access.telegramUserId),
        ["owner", "admin"],
      );
      if (!allowed) {
        await reply.status(403).send({ error: "forbidden" });
        return;
      }

      let url: string;
      try {
        url = await createCheckoutSession(getDb(), access.organizationId, priceKey);
      } catch (err: unknown) {
        if (err instanceof BillingCheckoutConflictError) {
          await reply.status(409).send({ error: "subscription already exists" });
          return;
        }
        throw err;
      }
      await reply.send({ url });
    },
  );

  app.post(
    "/billing/portal",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { token } = req.body as { token?: string };
      const access = verifyBillingAccessToken(token ?? "");
      if (!access) {
        await reply.status(401).send({ error: "invalid token" });
        return;
      }
      const allowed = await userHasOrganizationRole(
        getDb(),
        access.organizationId,
        BigInt(access.telegramUserId),
        ["owner", "admin"],
      );
      if (!allowed) {
        await reply.status(403).send({ error: "forbidden" });
        return;
      }

      const url = await createCustomerPortalSession(getDb(), access.organizationId);
      if (!url) {
        await reply.status(409).send({ error: "customer not found" });
        return;
      }

      await reply.send({ url });
    },
  );

  app.post(
    "/billing/stripe/webhook",
    { config: { rawBody: true }, bodyLimit: 256 * 1024 },
    async (req, reply) => {
      const signature = req.headers["stripe-signature"];
      const rawBody = req.rawBody;
      if (!signature || Array.isArray(signature) || !rawBody) {
        await reply.status(400).send({ error: "invalid webhook request" });
        return;
      }

      let event;
      try {
        event = constructWebhookEvent(rawBody, signature);
      } catch {
        await reply.status(400).send({ error: "invalid signature" });
        return;
      }

      const result = await processStripeWebhookEvent(getDb(), event);
      await reply.send({ status: result });
    },
  );
}
