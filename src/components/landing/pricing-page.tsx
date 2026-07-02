"use client";

import {
  PricingPlanCard,
  PricingTierSelector,
} from "@/components/pricing/pricing-card";
import {
  DEFAULT_PRICING_TIER_SLUG,
  type PricingTierSlug,
  getPricingCardsForSelection,
} from "@/components/pricing/pricing-catalog";
import Link from "next/link";
import { useState } from "react";

const GITHUB_URL = "https://github.com/namuh-eng/opensend";
const DOCS_URL = "/docs";
const HOSTED_SIGNIN_URL = "/auth";
const SELF_HOST_URL = `${GITHUB_URL}#self-host`;

const FAQ: Array<[string, string]> = [
  [
    "What happens if I exceed my quota?",
    "You get a soft warning at 80% and a notification at 100%. Sends are not blocked — overage is billed at $0.85 per 1,000 emails until you upgrade.",
  ],
  [
    "Do I have to use AWS SES?",
    "On Cloud, no — we manage the SES side for you. On Self-host, yes (for now). SMTP relay is on the roadmap.",
  ],
  [
    "Can I switch between Cloud and Self-host?",
    "Yes. Self-host is always free under the Elastic License 2.0 — you only pay AWS. You can also export your data and migrate at any time.",
  ],
  [
    "What does ELv2 mean for me?",
    "You can use, modify, and self-host opensend for free, including for commercial purposes. The only restriction is offering opensend itself as a hosted service to third parties.",
  ],
  [
    "Is there a yearly discount?",
    "Self-serve Cloud tiers are monthly so you can move with usage. Annual terms are handled through custom Scale agreements.",
  ],
  [
    "How do I cancel?",
    "From Settings → Billing. There's no contract — you can cancel anytime and keep your current period.",
  ],
];

const COMPARE_ROWS: string[][] = [
  ["Monthly emails", "15k", "51k-100k", "120k-500k", "Unlimited"],
  ["Verified domains", "3", "10", "1,000", "Unlimited"],
  ["API keys", "5", "10", "25", "Unlimited"],

  ["Webhooks", "✓", "✓", "✓", "✓"],
  ["Broadcasts", "✓", "✓", "✓", "✓"],
  ["Automations", "✓", "✓", "✓", "✓"],
  ["Dedicated IP", "—", "—", "Add-on", "Included"],
  ["SSO (Google)", "—", "—", "✓", "✓"],
  ["Audit log", "—", "—", "90 days", "Unlimited"],
  ["SLA", "—", "99.9%", "99.95%", "99.99%"],
  ["Support", "Community", "48h email", "12h email", "1h Slack"],
];

function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      style={{
        display: "block",
        filter:
          "drop-shadow(0 0 12px color-mix(in oklch, var(--accent) 40%, transparent))",
      }}
      role="img"
      aria-label="opensend"
    >
      <title>opensend</title>
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="7.4"
        fill="var(--accent)"
      />
      <path
        d="M6 11.2 L16 17 L26 11.2"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 21.5 L21.5 21.5"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M18.2 18.5 L21.8 21.5 L18.2 24.5"
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TopNav() {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        background: "rgba(10,10,12,0.7)",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <div
        className="wrap"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 60,
        }}
      >
        <Link
          href="/"
          aria-label="opensend home"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontWeight: 500,
            fontSize: 15,
            letterSpacing: "-0.01em",
          }}
        >
          <LogoMark />
          <span>opensend</span>
        </Link>
        <nav
          className="nav-links-desktop"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 28,
            fontSize: 13.5,
            color: "var(--fg-2)",
          }}
        >
          <Link href={DOCS_URL}>Docs</Link>
          <Link href={`${DOCS_URL}#api`}>API</Link>
          <a href={SELF_HOST_URL} rel="noreferrer noopener" target="_blank">
            Self-host
          </a>
          <Link href="/pricing" style={{ color: "var(--fg)" }}>
            Pricing
          </Link>
          <Link
            href={HOSTED_SIGNIN_URL}
            data-testid="nav-sign-in"
            className="btn btn-primary"
            style={{ height: 32, fontSize: 13 }}
          >
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}

function SelfHostLane() {
  return (
    <div
      className="sh-lane"
      style={{
        marginTop: 24,
        borderRadius: 16,
        border: "1px dashed var(--line-2)",
        background:
          "linear-gradient(180deg, rgba(177,140,255,0.04) 0%, transparent 60%)",
        padding: "24px 28px",
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 24,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 10,
          border: "1px solid var(--line-2)",
          background: "rgba(255,255,255,0.025)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--violet)",
        }}
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 22 22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <title>self-host</title>
          <rect x="3" y="4" width="16" height="14" rx="2" />
          <path d="M3 9h16M7 14l2 2 4-4" />
        </svg>
      </div>
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 4,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{ fontSize: 17, fontWeight: 500, letterSpacing: "-0.01em" }}
          >
            Self-host
          </span>
          <span
            className="mono"
            style={{
              padding: "2px 8px",
              borderRadius: 99,
              fontSize: 11,
              background: "rgba(177,140,255,0.12)",
              color: "var(--violet)",
              border: "1px solid rgba(177,140,255,0.25)",
            }}
          >
            free forever · ELv2
          </span>
        </div>
        <div
          style={{
            color: "var(--fg-2)",
            fontSize: 13.5,
            lineHeight: 1.5,
            maxWidth: 640,
          }}
        >
          Run opensend on your infrastructure. You only pay AWS SES — no
          per-email fees, no seat caps. Same source. Same dashboard. Same SDK.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <a
          href={SELF_HOST_URL}
          rel="noreferrer noopener"
          target="_blank"
          className="btn btn-ghost mono"
          style={{ fontSize: 12.5 }}
          data-testid="cta-self-host"
        >
          $ docker compose up
        </a>
        <a
          href={SELF_HOST_URL}
          rel="noreferrer noopener"
          target="_blank"
          className="btn btn-ghost"
          style={{ fontSize: 13 }}
        >
          Self-host docs ↗
        </a>
      </div>
    </div>
  );
}

function CompareTable() {
  const headers = ["Lite", "Starter", "Growth", "Scale"];
  return (
    <section style={{ padding: "80px 0" }}>
      <div className="wrap">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            marginBottom: 32,
            maxWidth: 720,
          }}
        >
          <span className="kicker">{"// compare plans"}</span>
          <h2 className="title-l">All the details.</h2>
        </div>
        <div
          style={{
            border: "1px solid var(--line-2)",
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          <div
            className="cmp-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "1.4fr repeat(4, 1fr)",
              background: "rgba(255,255,255,0.025)",
              borderBottom: "1px solid var(--line-2)",
            }}
          >
            <div style={{ padding: "18px 22px" }} />
            {headers.map((n, i) => (
              <div
                key={n}
                style={{
                  padding: "18px 22px",
                  borderLeft: "1px solid var(--line-2)",
                  position: "relative",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: i === 2 ? "var(--accent)" : "var(--fg-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                  }}
                >
                  {i === 2 ? "most popular" : "plan"}
                </div>
                <div style={{ fontSize: 16, fontWeight: 500, marginTop: 4 }}>
                  {n}
                </div>
                {i === 2 && (
                  <span
                    style={{
                      position: "absolute",
                      top: 14,
                      right: 16,
                      width: 6,
                      height: 6,
                      borderRadius: 99,
                      background: "var(--accent)",
                      boxShadow: "0 0 10px var(--accent)",
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          {COMPARE_ROWS.map((r, i) => (
            <div
              key={r[0]}
              className="cmp-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "1.4fr repeat(4, 1fr)",
                borderTop: i ? "1px solid var(--line)" : "none",
              }}
            >
              <div
                style={{
                  padding: "13px 22px",
                  fontFamily: "var(--landing-mono)",
                  fontSize: 12,
                  color: "var(--fg-3)",
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                {r[0]}
              </div>
              {r.slice(1).map((cell, j) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                  key={j}
                  style={{
                    padding: "13px 22px",
                    borderLeft: "1px solid var(--line)",
                    fontSize: 13.5,
                    color:
                      cell === "—"
                        ? "var(--fg-4)"
                        : j === 2
                          ? "var(--fg)"
                          : "var(--fg-2)",
                    fontFamily:
                      cell === "✓" || cell === "—"
                        ? "var(--landing-mono)"
                        : "inherit",
                  }}
                >
                  {cell}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FAQSection() {
  const [open, setOpen] = useState(0);
  return (
    <section style={{ padding: "40px 0 100px" }}>
      <div className="wrap">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            marginBottom: 32,
            maxWidth: 720,
          }}
        >
          <span className="kicker">{"// questions"}</span>
          <h2 className="title-l">Things people ask.</h2>
        </div>
        <div
          style={{
            border: "1px solid var(--line-2)",
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          {FAQ.map(([q, a], i) => {
            const isOpen = open === i;
            return (
              <div
                key={q}
                style={{ borderTop: i ? "1px solid var(--line)" : "none" }}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  aria-expanded={isOpen}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    cursor: "pointer",
                    padding: "18px 22px",
                    background: isOpen
                      ? "rgba(255,255,255,0.02)"
                      : "transparent",
                    border: "none",
                    color: "var(--fg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontSize: 15,
                    fontWeight: 500,
                    letterSpacing: "-0.005em",
                  }}
                >
                  <span>{q}</span>
                  <span
                    aria-hidden="true"
                    style={{
                      transition: "transform 200ms ease",
                      transform: isOpen ? "rotate(45deg)" : "rotate(0)",
                      color: "var(--fg-3)",
                      fontSize: 18,
                    }}
                  >
                    +
                  </span>
                </button>
                <div
                  style={{
                    maxHeight: isOpen ? 240 : 0,
                    overflow: "hidden",
                    transition: "max-height 250ms ease",
                  }}
                >
                  <div
                    style={{
                      padding: "0 22px 20px",
                      color: "var(--fg-2)",
                      fontSize: 14,
                      lineHeight: 1.6,
                      maxWidth: 720,
                    }}
                  >
                    {a}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function MiniFooter() {
  return (
    <footer style={{ borderTop: "1px solid var(--line)", padding: "32px 0" }}>
      <div
        className="wrap"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div className="mono" style={{ fontSize: 11.5, color: "var(--fg-4)" }}>
          ELv2 · {new Date().getFullYear()} · opensend
        </div>
        <div
          style={{
            display: "flex",
            gap: 22,
            fontSize: 13,
            color: "var(--fg-3)",
          }}
        >
          <Link href="/">← Back to home</Link>
          <Link href={DOCS_URL}>Docs</Link>
          <a href={GITHUB_URL} rel="noreferrer noopener" target="_blank">
            GitHub
          </a>
          <span>Status</span>
        </div>
      </div>
    </footer>
  );
}

export function PricingPage() {
  const [selectedTierSlug, setSelectedTierSlug] = useState<PricingTierSlug>(
    DEFAULT_PRICING_TIER_SLUG,
  );

  return (
    <div className="landing-root">
      <div className="grain" aria-hidden="true" />
      <div className="landing-content">
        <TopNav />

        <section style={{ padding: "80px 0 30px", position: "relative" }}>
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: -200,
              left: "50%",
              transform: "translateX(-50%)",
              width: 1100,
              height: 600,
              background:
                "radial-gradient(ellipse at center, color-mix(in oklch, var(--accent) 18%, transparent) 0%, transparent 60%)",
              filter: "blur(60px)",
              pointerEvents: "none",
            }}
          />
          <div
            className="wrap"
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
              gap: 22,
            }}
          >
            <span className="pill">
              <span className="dot" /> simple pricing · cancel anytime
            </span>
            <h1 className="title-l" style={{ maxWidth: 820 }}>
              Pay for sending,
              <br />
              <span className="serif" style={{ color: "var(--fg-2)" }}>
                not for licenses.
              </span>
            </h1>
            <p className="body" style={{ maxWidth: 580 }}>
              Start with Lite for hosted sending, or self-host the same source
              for free forever — opensend is ELv2 either way.
            </p>

            <PricingTierSelector
              selectedSlug={selectedTierSlug}
              onChange={setSelectedTierSlug}
            />
          </div>
        </section>

        <section style={{ padding: "40px 0" }}>
          <div className="wrap">
            <div
              className="plan-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, 1fr)",
                gap: 18,
              }}
            >
              {getPricingCardsForSelection(selectedTierSlug).map((plan) => (
                <PricingPlanCard
                  key={plan.family}
                  plan={plan}
                  testId={`plan-${plan.family}`}
                />
              ))}
            </div>
            <SelfHostLane />
          </div>
        </section>

        <CompareTable />
        <hr className="line" />
        <FAQSection />
        <MiniFooter />
      </div>
    </div>
  );
}
