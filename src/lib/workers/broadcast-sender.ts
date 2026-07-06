import { reserveEmailQuota } from "@/lib/billing/quota";
import { db } from "@/lib/db";
import {
  broadcasts,
  contacts,
  emails,
  segments,
  topics,
} from "@/lib/db/schema";
import {
  buildOneClickUnsubscribeHeaders,
  createUnsubscribeUrl,
  getPublicBaseUrl,
  replaceUnsubscribePlaceholder,
} from "@/lib/unsubscribe";
import {
  isSubscribedToTopic,
  normalizeTopicSubscriptions,
} from "@opensend/core";
import { and, eq, lte, sql } from "drizzle-orm";

/**
 * processScheduledBroadcasts
 *
 * Scans for broadcasts with status 'queued' or 'scheduled' (with scheduledAt in the past).
 * Fills in the actual email fanout and updates status to 'sent'.
 */
export async function processScheduledBroadcasts() {
  const now = new Date();

  // 1. Find pending broadcasts
  const pending = await db
    .select()
    .from(broadcasts)
    .where(
      and(
        sql`${broadcasts.status} IN ('queued', 'scheduled')`,
        lte(broadcasts.scheduledAt, now),
      ),
    )
    .limit(5); // Process in small batches for fanout safety

  if (pending.length === 0) return { processed: 0 };

  let totalEmailsCreated = 0;

  for (const broadcast of pending) {
    try {
      // 2. Mark as 'sending' to prevent double-processing
      await db
        .update(broadcasts)
        .set({ status: "sending" })
        .where(eq(broadcasts.id, broadcast.id));

      // 3. Resolve audience contacts
      let targetContacts: {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
        topicSubscriptions: Array<{
          topicId: string;
          subscribed: boolean;
        }> | null;
      }[] = [];

      const broadcastUserId = broadcast.userId;
      if (!broadcastUserId) {
        await db
          .update(broadcasts)
          .set({ status: "failed" })
          .where(eq(broadcasts.id, broadcast.id));
        console.error(
          `Failed to process broadcast ${broadcast.id}: missing owner`,
        );
        continue;
      }

      if (broadcast.audienceId) {
        // Resolve segment contacts (naive JSON check for now)
        const [segment] = await db
          .select({ name: segments.name })
          .from(segments)
          .where(
            and(
              eq(segments.id, broadcast.audienceId),
              eq(segments.userId, broadcastUserId),
            ),
          )
          .limit(1);
        if (segment) {
          targetContacts = await db
            .select({
              id: contacts.id,
              email: contacts.email,
              firstName: contacts.firstName,
              lastName: contacts.lastName,
              topicSubscriptions: contacts.topicSubscriptions,
            })
            .from(contacts)
            .where(
              and(
                eq(contacts.unsubscribed, false),
                eq(contacts.userId, broadcastUserId),
                sql`${contacts.segments} ? ${segment.name}`,
              ),
            );
        }
      } else {
        // Fallback: send to all subscribed contacts if no segment specified
        targetContacts = await db
          .select({
            id: contacts.id,
            email: contacts.email,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            topicSubscriptions: contacts.topicSubscriptions,
          })
          .from(contacts)
          .where(
            and(
              eq(contacts.unsubscribed, false),
              eq(contacts.userId, broadcastUserId),
            ),
          );
      }

      if (broadcast.topicId) {
        const topic = await db.query.topics.findFirst({
          where: and(
            eq(topics.id, broadcast.topicId),
            eq(topics.userId, broadcastUserId),
          ),
        });
        targetContacts = topic
          ? targetContacts.filter((contact) =>
              isSubscribedToTopic(
                topic,
                normalizeTopicSubscriptions(contact.topicSubscriptions),
              ),
            )
          : [];
      }

      // 3.5 Billing gate + fanout in ONE transaction: reserve quota once for
      // the whole audience, create all email rows, and mark 'sent' atomically
      // so there is never a partial fanout. On billing block/error the
      // transaction rolls back (no reservation, no rows).
      const targetCount = targetContacts.length;
      let blockedBilling = false;
      let createdInTx = 0;
      try {
        await db.transaction(async (tx) => {
          createdInTx = 0;
          const reservation = await reserveEmailQuota(
            broadcastUserId,
            targetCount,
            now,
            process.env,
            tx,
          );
          if (!reservation.ok) {
            blockedBilling = true;
            throw new Error("broadcast_blocked_billing");
          }

          for (const contact of targetContacts) {
            let html = broadcast.html || "";
            let subject = broadcast.subject || "";

            const vars = {
              FIRST_NAME: contact.firstName || "",
              LAST_NAME: contact.lastName || "",
              EMAIL: contact.email,
            };
            for (const [key, value] of Object.entries(vars)) {
              const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g");
              html = html.replace(regex, value);
              subject = subject.replace(regex, value);
            }

            const unsubscribeUrl = createUnsubscribeUrl(
              contact.id,
              getPublicBaseUrl(),
              { topicId: broadcast.topicId, broadcastId: broadcast.id },
            );
            html = replaceUnsubscribePlaceholder(html, unsubscribeUrl);
            const text = replaceUnsubscribePlaceholder(
              broadcast.text || "",
              unsubscribeUrl,
            );

            await tx.insert(emails).values({
              from: broadcast.from || "system@opensend.com",
              to: [contact.email],
              subject,
              html,
              text,
              headers: buildOneClickUnsubscribeHeaders(unsubscribeUrl),
              status: "queued",
              userId: broadcast.userId,
              topicId: broadcast.topicId,
              tags: [{ name: "broadcast_id", value: broadcast.id }],
            });
            createdInTx++;
          }

          await tx
            .update(broadcasts)
            .set({ status: "sent" })
            .where(eq(broadcasts.id, broadcast.id));
        });
        totalEmailsCreated += createdInTx;
      } catch (txErr) {
        if (blockedBilling) {
          await db
            .update(broadcasts)
            .set({ status: "blocked_billing" })
            .where(eq(broadcasts.id, broadcast.id));
          continue;
        }
        throw txErr;
      }
    } catch (err) {
      console.error(`Failed to process broadcast ${broadcast.id}:`, err);
      // Transaction rolled back (no rows, no reservation); requeue for retry.
      await db
        .update(broadcasts)
        .set({ status: "queued" })
        .where(eq(broadcasts.id, broadcast.id));
    }
  }

  return {
    processed: pending.length,
    emailsCreated: totalEmailsCreated,
  };
}
