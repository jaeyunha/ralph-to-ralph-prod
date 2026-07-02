import {
  BillingView,
  type BillingViewSummary,
} from "@/components/billing/billing-view";
import { getServerSession } from "@/lib/api-auth";
import { isBillingEnabled } from "@/lib/billing";
import { loadBillingSummary } from "@/lib/billing/summary";
import Link from "next/link";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function BillingSettingsPage() {
  const session = await getServerSession();
  if (!session?.user?.id) {
    redirect("/auth");
  }

  if (!isBillingEnabled()) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-fg">Billing</h1>
          <p className="text-[14px] text-fg-2">
            Billing is not enabled for this Opensend deployment.
          </p>
        </div>
        <div className="rounded-lg border border-line bg-bg-2 p-4">
          <p className="text-[13px] text-fg-2">
            Your dashboard is still available, but plan management and checkout
            are unavailable until the deployment owner configures billing.
          </p>
        </div>
        <Link
          href="/settings"
          className="inline-flex rounded-md border border-line bg-bg-3 px-3 py-1.5 text-[13px] font-medium text-fg transition-colors hover:bg-bg-card"
        >
          Back to settings
        </Link>
      </div>
    );
  }

  const summary = await loadBillingSummary(session.user.id);
  if (!summary) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold text-fg">Billing</h1>
        <p className="text-[14px] text-fg-2">
          No billing plan record was found. Run the database seed to create the
          hosted paid plans.
        </p>
      </div>
    );
  }

  const initial: BillingViewSummary = {
    plan: {
      id: summary.plan.id,
      slug: summary.plan.slug,
      name: summary.plan.name,
      monthlyPriceCents: summary.plan.monthlyPriceCents,
      monthlyEmailQuota: summary.plan.monthlyEmailQuota,
      maxDomains: summary.plan.maxDomains,
      maxApiKeys: summary.plan.maxApiKeys,
    },
    subscription: summary.subscription
      ? {
          id: summary.subscription.id,
          status: summary.subscription.status,
          currentPeriodStart: summary.subscription.currentPeriodStart,
          currentPeriodEnd: summary.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: summary.subscription.cancelAtPeriodEnd,
        }
      : null,
    usage: {
      emails: summary.usage.emails,
      domains: summary.usage.domains,
      apiKeys: summary.usage.apiKeys,
      periodStart: summary.usage.periodStart,
      periodEnd: summary.usage.periodEnd,
      hasUsagePeriod: summary.usage.hasUsagePeriod,
    },
  };

  return <BillingView initial={initial} />;
}
