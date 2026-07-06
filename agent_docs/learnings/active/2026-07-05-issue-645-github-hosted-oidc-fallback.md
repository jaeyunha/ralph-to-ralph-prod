---
date: 2026-07-05
issue: "#645"
type: decision
promoted_to: null
---

## GitHub-hosted OIDC deploy fallback

**What:** Production deploy now keeps the Mac mini runner as the automatic push path, but `workflow_dispatch` exposes a `github-hosted-oidc` path that runs the same preflight and `scripts/deploy.sh all` on `ubuntu-latest` after assuming `vars.AWS_DEPLOY_ROLE_ARN`.

**Why:** A documented workstation runbook is useful, but an incident fallback should stay inside GitHub Actions when the only failed component is the physical self-hosted runner. OIDC avoids copying AWS keys into GitHub secrets and keeps the deploy primitive identical to the normal path.

**Fix:** Keep the fallback gated to manual workflow dispatch, require `PLATFORM=linux/amd64`, run `bun run deploy:fallback:preflight` before any mutation, and grant the OIDC role only deploy-time AWS permissions plus Secrets Manager metadata lookup, not secret value reads.
