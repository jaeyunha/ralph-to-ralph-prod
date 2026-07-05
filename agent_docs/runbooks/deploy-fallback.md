# Deploy fallback runbook for Mac mini runner outage

Issue: #645

OpenSend production deploys normally run through `.github/workflows/deploy.yml` on the `[self-hosted, opensend-deploy]` Mac mini runner. If that runner is offline or unreachable, use the GitHub-hosted OIDC fallback in the same workflow, or the local workstation fallback from a trusted non-Mac-mini machine that is already authorized for production AWS deploys.

The GitHub-hosted OIDC path is the preferred break-glass path because it keeps deployment inside GitHub Actions while removing the physical Mac mini dependency. The workstation path remains available when GitHub Actions cannot assume the deploy role or the workflow control plane itself is impaired. Neither path replaces the normal Mac mini runner until a real no-op fallback deploy exercise is completed and recorded.

## Prerequisites

Use a trusted operator machine with:

- A clean checkout of `namuh-eng/opensend` at the intended production SHA.
- Docker with `buildx` available and able to build `linux/amd64` images.
- AWS CLI authenticated to the production AWS account with permissions for STS, ECR, ECS, CloudWatch Logs, and Secrets Manager metadata lookups.
- Docker authenticated to the production ECR registry; the preflight performs this with `aws ecr get-login-password | docker login --password-stdin` and does not print the password.
- Network access to AWS ECR/ECS/Secrets Manager in the deploy region.
- No copied GitHub Actions secrets and no dumped runner environment. Authenticate through an operator AWS profile, SSO session, or equivalent approved AWS credential source.
- For GitHub-hosted OIDC fallback: repository variables `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `AWS_ACCOUNT_ID`, `ECS_CLUSTER`, and `PRODUCT` configured for production. `AWS_DEPLOY_ROLE_ARN` must trust this repository's GitHub Actions OIDC subject for manual Deploy workflow runs.

Required tools:

```bash
bun --version
docker --version
docker buildx version
python3 --version
aws --version
```

If Bun is missing, install it through the workstation's approved package manager or bootstrap process, then rerun `bun --version` before preflight.

## Non-secret environment contract

`scripts/deploy.sh` is the portable deployment primitive used by `.github/workflows/deploy.yml`. The fallback path uses the same script and accepts these non-secret environment names:

| Name | Default | Purpose |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | AWS deploy region. |
| `AWS_ACCOUNT_ID` | resolved from `aws sts get-caller-identity` | Optional account guard. Set it to fail fast if authenticated to the wrong account. |
| `PRODUCT` | `opensend` | Prefix for repositories and services. |
| `ECS_CLUSTER` | `namuh` | ECS cluster name. |
| `IMAGE_TAG` | `latest` | Image tag pushed to ECR. |
| `PLATFORM` | `linux/amd64` | Docker build target platform. The fallback contract only permits `linux/amd64` for production Fargate images. |
| `WEBHOOK_SECRET_ENCRYPTION_KEY_SECRET_ID` | `opensend/webhook/secret-encryption-key` | Required Secrets Manager identifier for webhook secret encryption key metadata. |
| `WEBHOOK_SECRET_ENCRYPTION_KEY_SECRET_ARN` | unset | Optional ARN override for the same secret metadata when the ARN is already known. |
| `TRACKING_SECRET_SECRET_ID` | `opensend/tracking-secret` | Required Secrets Manager identifier for tracking secret metadata. |
| `TRACKING_SECRET_SECRET_ARN` | unset | Optional ARN override for the same secret metadata when the ARN is already known. |
| `INGESTER_JOB_TOKEN_SECRET_ID` | `opensend/ingester-job-token` | Required Secrets Manager identifier for ingester job token metadata. |
| `INGESTER_JOB_TOKEN_SECRET_ARN` | unset | Optional ARN override for the same secret metadata when the ARN is already known. |
| `INGESTER_INBOUND_TOKEN_SECRET_ID` | `opensend/ingester-inbound-token` | Required Secrets Manager identifier for ingester inbound token metadata. |
| `INGESTER_INBOUND_TOKEN_SECRET_ARN` | unset | Optional ARN override for the same secret metadata when the ARN is already known. |

Do not run `env`, `printenv`, `aws secretsmanager get-secret-value`, or any command that prints credential material into logs, issues, PRs, terminals being recorded, or chat. The fallback deploy only needs secret name/ARN metadata through `aws secretsmanager describe-secret`; it must not fetch secret values.

ECR repository and ECS service names are derived by `scripts/deploy.sh` from `PRODUCT` as `${PRODUCT}-app` and `${PRODUCT}-ingester`. The scheduler service defaults to `${PRODUCT}-scheduler`; if `SCHED_SERVICE` is set, the preflight validates that same scheduler service name before deploy. Do not set separate app/ingester repository or service override names for the fallback path unless `scripts/deploy.sh` is changed to honor them first.

## GitHub-hosted OIDC fallback

Use this path first when the Mac mini runner is the only blocker and GitHub Actions itself is healthy:

1. Open **Actions → Deploy → Run workflow**.
2. Select the production branch/SHA intended for deployment.
3. Set `deploy_path` to `github-hosted-oidc`.
4. Start the run and monitor the `Deploy via GitHub-hosted OIDC fallback` job.

The fallback job runs on `ubuntu-latest`, installs Bun with `oven-sh/setup-bun@v2`, requests an OIDC token with `id-token: write`, assumes `vars.AWS_DEPLOY_ROLE_ARN`, runs `bun run deploy:fallback:preflight`, then runs `bash scripts/deploy.sh all`. The preflight performs the same non-mutating checks documented below before any image push, task registration, migration task, or ECS service update.

Required GitHub repository variables:

| Name | Purpose |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | IAM role assumed by `aws-actions/configure-aws-credentials` through GitHub Actions OIDC. |
| `AWS_REGION` | AWS deploy region; defaults to `us-east-1` in the workflow when unset. |
| `AWS_ACCOUNT_ID` | Optional account guard passed through to `scripts/deploy.sh` and the preflight. |
| `ECS_CLUSTER` | ECS cluster name; defaults to `namuh` in the workflow when unset. |
| `PRODUCT` | Service/repository prefix; defaults to `opensend` in the workflow when unset. |

The OIDC role needs the same production permissions as the Mac mini deploy identity for STS, ECR push/login, ECS service/task-definition updates, migration task execution, CloudWatch Logs reads/writes used by the deploy script, and Secrets Manager `describe-secret` metadata lookups. It must not grant `secretsmanager:GetSecretValue` for this deploy path.

## Preflight

Run the preflight before any fallback deploy attempt:

```bash
bun run deploy:fallback:preflight
```

The preflight does not push images, update ECS, run tasks, register task definitions, or fetch secret values. It does write/refresh the local Docker ECR login entry for the resolved registry so `docker buildx build --push` can authenticate before any image build starts. It verifies:

- Bun is available to run the repository preflight command.
- Docker CLI and Docker `buildx` are available.
- `PLATFORM` is exactly `linux/amd64`; inherited Apple Silicon values such as `linux/arm64` fail preflight before fallback deploy approval.
- AWS CLI can resolve the caller identity.
- The optional `AWS_ACCOUNT_ID` matches the authenticated AWS account.
- Docker can authenticate to the resolved ECR registry using `aws ecr get-login-password` piped to `docker login --password-stdin`; the password is not printed.
- ECR repositories for the app and ingester are reachable.
- ECS services in the configured cluster are reachable and both the app and ingester services report `ACTIVE` status. If a service is `DRAINING`, `INACTIVE`, or otherwise not active, the preflight fails with the affected service/status before any image push or ECS mutation.
- The scheduler service is either absent or reports `ACTIVE` status. If the scheduler service is `DRAINING` or `INACTIVE`, the preflight fails before any image push or ECS mutation because `scripts/deploy.sh all` would otherwise treat a draining scheduler as redeployable and fail late.
- The current task definitions for the app and ingester services are readable and include the expected app and ingester containers.
- The current app task definition includes the production app startup-required environment or secret metadata names enforced at boot by `src/lib/startup-checks.ts`: `DATABASE_URL`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_TRUSTED_ORIGINS`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, `TRACKING_SECRET`, `UNSUBSCRIBE_SECRET`, and `DKIM_ENCRYPTION_KEY`. This checks names only; it does not fetch, print, or compare secret values. The check fails before any image push or ECS task-definition mutation if the cloned app base task lacks metadata needed for production boot.
- The current ingester task definition includes the scheduler base task secret metadata required by `bash scripts/deploy.sh all`: `DATABASE_URL` and `BETTER_AUTH_SECRET` on the ingester container. This validates secret names only; it does not fetch or print secret values.
- The current ingester task definition includes the production ingester startup-required environment or secret metadata names enforced at boot by `packages/ingester/src/startup-checks.ts`: `DATABASE_URL`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `BETTER_AUTH_SECRET`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, `INGESTER_JOB_TOKEN`, `INGESTER_INBOUND_TOKEN`, `TRACKING_SECRET`, `UNSUBSCRIBE_SECRET`, and `DKIM_ENCRYPTION_KEY`. This checks names only; it does not fetch, print, or compare secret values.
- Required Secrets Manager secret name/ARN metadata for the webhook encryption key, tracking secret, ingester job token, and ingester inbound token is resolvable without fetching values.

If the preflight fails, do not deploy. Fix the failing tool, auth, account, network, repository, service, or secret-name issue first.

## Fallback deploy flow

1. Confirm the Mac mini runner outage or self-hosted runner unavailability is the blocker. Do not use this path for routine deploys while the normal runner is healthy.
2. Fetch and inspect the intended production SHA:

   ```bash
   git fetch origin main staging
   git status -sb
   git rev-parse HEAD
   git diff --check HEAD
   ```

3. Export only non-secret overrides if needed. Prefer setting `AWS_ACCOUNT_ID` as an account guard:

   ```bash
   export AWS_REGION=us-east-1
   export AWS_ACCOUNT_ID=<production-account-id>
   export ECS_CLUSTER=namuh
   export PRODUCT=opensend
   export PLATFORM=linux/amd64
   ```

   `PLATFORM` must be `linux/amd64`; do not use an inherited `linux/arm64` or other local-architecture override for production fallback deploys.

4. Run the preflight:

   ```bash
   bun run deploy:fallback:preflight
   ```

5. Deploy with the same primitive used by `.github/workflows/deploy.yml`:

   ```bash
   bash scripts/deploy.sh all
   ```

6. Save the terminal output in an operator-private location if needed. Do not paste secrets, AWS credential env vars, or full environment dumps into GitHub.

## Verification and rollback

After `bash scripts/deploy.sh all` finishes, verify:

```bash
aws ecs describe-services \
  --region "${AWS_REGION:-us-east-1}" \
  --cluster "${ECS_CLUSTER:-namuh}" \
  --services "${PRODUCT:-opensend}-app" "${PRODUCT:-opensend}-ingester" \
  --query 'services[].{service:serviceName,status:status,desired:desiredCount,running:runningCount,taskDefinition:taskDefinition}' \
  --output table
```

Also check the public endpoints printed by `scripts/deploy.sh` and the recent ECS/CloudWatch events for both services.

Rollback is currently the same as the normal ECS image rollback process: identify the previous known-good image/task definition from ECR/ECS history, update the affected service back to that task definition or image, and wait for ECS stability. Record the task definitions and SHAs involved before and after rollback. If migrations ran, evaluate database compatibility before rolling back app code.

## Recording a no-op fallback deploy exercise

Before declaring issue #645 fully closed, run one real no-op fallback deploy from a non-Mac-mini machine against the current production SHA. This is intentionally outside this PR because it mutates production by pushing images and forcing ECS deployments.

Record the exercise in issue #645 or in this runbook with:

- Date/time and operator.
- Source machine type, explicitly noting it was not the Mac mini runner.
- Git SHA deployed.
- Preflight result.
- `bash scripts/deploy.sh all` result.
- ECS service stability result.
- Any rollback or follow-up required.

Until that exercise is recorded, this runbook and preflight provide a documented break-glass path, but the production deploy SPOF is not proven fully closed.
