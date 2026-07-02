// ABOUTME: Static deployment tests for the app + ingester ECS Fargate split
// ABOUTME: Verifies repo-visible Docker, compose, deploy script, and runbook wiring

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

type ServiceStatus = "ACTIVE" | "DRAINING" | "INACTIVE";
type SchedulerServiceStatus = ServiceStatus | "ABSENT";

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function runPreflightWithServiceStatuses(
  appStatus: ServiceStatus,
  ingesterStatus: ServiceStatus,
  options: {
    schedulerStatus?: SchedulerServiceStatus;
    platform?: string;
  } = {},
): { status: number | null; stdout: string; stderr: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "opensend-deploy-preflight-"));
  const binDir = join(tempDir, "bin");
  mkdirSync(binDir);

  writeExecutable(
    join(binDir, "bun"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "1.3.8"
  exit 0
fi
echo "unexpected bun args: $*" >&2
exit 1
`,
  );
  writeExecutable(
    join(binDir, "python3"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "Python 3.13.0"
  exit 0
fi
echo "unexpected python3 args: $*" >&2
exit 1
`,
  );
  writeExecutable(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "Docker version 27.0.0"
  exit 0
fi
if [ "$1" = "buildx" ] && [ "$2" = "version" ]; then
  echo "github.com/docker/buildx v0.16.0"
  exit 0
fi
if [ "$1" = "login" ]; then
  cat >/dev/null
  echo "Login Succeeded"
  exit 0
fi
echo "unexpected docker args: $*" >&2
exit 1
`,
  );
  writeExecutable(
    join(binDir, "aws"),
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [ "$1" = "--version" ]; then
  echo "aws-cli/2.17.0"
  exit 0
fi
if [ "$1 $2" = "sts get-caller-identity" ]; then
  echo "123456789012"
  exit 0
fi
if [ "$1 $2" = "ecr get-login-password" ]; then
  echo "fake-password-not-a-secret-value"
  exit 0
fi
if [ "$1 $2" = "ecr describe-repositories" ]; then
  printf 'opensend-app\topensend-ingester\n'
  exit 0
fi
if [ "$1 $2" = "ecs describe-services" ]; then
  if [[ "$args" == *"{services:services[].{serviceName:serviceName,status:status},failures:failures[].{arn:arn,reason:reason}}"* ]]; then
    if [ "\${SCHEDULER_SERVICE_STATUS}" = "ABSENT" ]; then
      printf '{"services":[],"failures":[{"arn":"arn:aws:ecs:us-east-1:123456789012:service/namuh/opensend-scheduler","reason":"MISSING"}]}\n'
      exit 0
    fi
    printf '{"services":[{"serviceName":"opensend-scheduler","status":"%s"}],"failures":[]}\n' "\${SCHEDULER_SERVICE_STATUS}"
    exit 0
  fi
  if [[ "$args" == *"services[].{serviceName:serviceName,status:status}"* ]]; then
    printf '[{"serviceName":"opensend-app","status":"%s"},{"serviceName":"opensend-ingester","status":"%s"}]\n' "\${APP_SERVICE_STATUS}" "\${INGESTER_SERVICE_STATUS}"
    exit 0
  fi
  if [[ "$args" == *"{serviceName:services[0].serviceName,taskDefinition:services[0].taskDefinition}"* ]]; then
    service="opensend-app"
    if [[ "$args" == *"opensend-ingester"* ]]; then
      service="opensend-ingester"
    fi
    printf '{"serviceName":"%s","taskDefinition":"arn:aws:ecs:us-east-1:123456789012:task-definition/%s:42"}\n' "$service" "$service"
    exit 0
  fi
fi
if [ "$1 $2" = "ecs describe-task-definition" ]; then
  container="opensend-app"
  if [[ "$args" == *"opensend-ingester"* ]]; then
    container="opensend-ingester"
  fi
  printf '{"family":"%s","containers":[{"name":"%s","secrets":["DATABASE_URL","BETTER_AUTH_URL","NEXT_PUBLIC_APP_URL","BETTER_AUTH_SECRET","BETTER_AUTH_TRUSTED_ORIGINS","WEBHOOK_SECRET_ENCRYPTION_KEY","INGESTER_JOB_TOKEN","INGESTER_INBOUND_TOKEN","TRACKING_SECRET","UNSUBSCRIBE_SECRET","DKIM_ENCRYPTION_KEY"],"environment":[]}]}\n' "$container" "$container"
  exit 0
fi
if [ "$1 $2" = "secretsmanager describe-secret" ]; then
  echo '{"Name":"metadata-only","ARN":"arn:aws:secretsmanager:us-east-1:123456789012:secret:metadata-only"}'
  exit 0
fi
echo "unexpected aws args: $*" >&2
exit 1
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      ["tools/deploy-fallback-preflight.ts"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          APP_SERVICE_STATUS: appStatus,
          INGESTER_SERVICE_STATUS: ingesterStatus,
          PLATFORM: options.platform ?? "linux/amd64",
          SCHEDULER_SERVICE_STATUS: options.schedulerStatus ?? "ACTIVE",
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          SECRET_VALUE_DO_NOT_PRINT: "this-secret-value-must-not-appear",
        },
      },
    );

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function serviceBlock(compose: string, serviceName: string): string {
  const escapedServiceName = serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = compose.match(
    new RegExp(
      `\\n  ${escapedServiceName}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:\\n|\\nvolumes:\\n|$)`,
    ),
  );
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("deploy-001: ECS Fargate deployment configuration", () => {
  it("next.config.js has standalone output for Docker deployment", () => {
    const config = readFileSync(join(root, "next.config.js"), "utf-8");
    expect(config).toContain('output: "standalone"');
  });

  it("allows PostHog browser assets in the production CSP", () => {
    const config = readFileSync(join(root, "next.config.js"), "utf-8");
    expect(config).toContain("https://us-assets.i.posthog.com");
    expect(config).toContain("connect-src 'self' https:");
  });

  it("Dockerfile exists with multi-stage build", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("FROM oven/bun:1.3.8-alpine AS base");
    expect(dockerfile).toContain("AS deps");
    expect(dockerfile).toContain("AS builder");
    expect(dockerfile).toContain("AS runner");
    expect(dockerfile).toContain("bun run build");
    expect(dockerfile).toContain(".next/standalone");
  });

  it("Dockerfile exposes port 8080 for Fargate", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain("ENV PORT=8080");
  });

  it("Dockerfile includes a migration runner image", () => {
    const dockerfile = readFileSync(join(root, "Dockerfile"), "utf-8");
    expect(dockerfile).toContain("FROM base AS migrator");
    expect(dockerfile).toContain("COPY drizzle ./drizzle");
    expect(dockerfile).toContain("COPY src/lib/db/migrate.ts");
    expect(dockerfile).toContain('CMD ["bun", "src/lib/db/migrate.ts"]');
  });

  it("deploy script builds, pushes, and force-redeploys ECS services", () => {
    const scriptPath = join(root, "scripts", "deploy.sh");
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, "utf-8");
    expect(script).toContain("buildx build");
    expect(script).toContain("linux/amd64");
    expect(script).toContain("ecs update-service");
    expect(script).toContain("--force-new-deployment");
    expect(script).toContain("aws ecs wait services-stable");
  });

  it("deploy script injects required production app secrets into ECS task definitions", () => {
    const script = readFileSync(join(root, "scripts", "deploy.sh"), "utf-8");
    expect(script).toContain("WEBHOOK_SECRET_ENCRYPTION_KEY_SECRET_ID");
    expect(script).toContain("TRACKING_SECRET_SECRET_ID");
    expect(script).toContain("UNSUBSCRIBE_SECRET_SECRET_ID");
    expect(script).toContain("DKIM_ENCRYPTION_KEY_SECRET_ID");
    expect(script).toContain("aws secretsmanager describe-secret");
    expect(script).toContain('"name": "WEBHOOK_SECRET_ENCRYPTION_KEY"');
    expect(script).toContain('"name": "TRACKING_SECRET"');
    expect(script).toContain('"name": "UNSUBSCRIBE_SECRET"');
    expect(script).toContain('"name": "DKIM_ENCRYPTION_KEY"');
    expect(script).toContain('"NEXT_PUBLIC_APP_URL"');
    expect(script).toContain('"BETTER_AUTH_TRUSTED_ORIGINS"');
    expect(script).toContain("register_app_task_definition");
    expect(script).toContain(
      'redeploy "${APP_SERVICE}" "${APP_TASK_DEFINITION}"',
    );
  });

  it("deploy script injects the SES events SNS topic ARN into the app task environment when configured", () => {
    const script = readFileSync(join(root, "scripts", "deploy.sh"), "utf-8");
    expect(script).toContain(
      'SES_EVENTS_SNS_TOPIC_ARN="${SES_EVENTS_SNS_TOPIC_ARN:-}"',
    );
    expect(script).toContain(
      'SES_INBOUND_SNS_TOPIC_ARN="${SES_INBOUND_SNS_TOPIC_ARN:-}"',
    );
    expect(script).toContain(
      'SES_INBOUND_SNS_TOPIC_ARNS="${SES_INBOUND_SNS_TOPIC_ARNS:-}"',
    );
    expect(script).toContain('"name": topic_name');
    expect(script).toContain('"value": topic_value');
    expect(script).toContain('"SES_EVENTS_SNS_TOPIC_ARN"');
    expect(script).toContain('"SES_INBOUND_SNS_TOPIC_ARN"');
    expect(script).toContain('"SES_INBOUND_SNS_TOPIC_ARNS"');
    expect(script).toContain('"${SES_EVENTS_SNS_TOPIC_ARN}"');
    expect(script).toContain('"${SES_INBOUND_SNS_TOPIC_ARN}"');
    expect(script).toContain('"${SES_INBOUND_SNS_TOPIC_ARNS}"');
    expect(script).toContain('"${task_file}"');
  });

  it("deploy script injects the SES events SNS topic ARN into the ingester task environment", () => {
    const script = readFileSync(join(root, "scripts", "deploy.sh"), "utf-8");
    expect(script).toContain(
      'write_ingester_task_definition \\\n    "${base_task_definition}" \\\n    "${ingester_image}"',
    );
    expect(script).toContain('"${SES_EVENTS_SNS_TOPIC_ARN}"');
    expect(script).toContain('"${SES_INBOUND_SNS_TOPIC_ARN}"');
    expect(script).toContain('"${SES_INBOUND_SNS_TOPIC_ARNS}"');
    expect(script).toContain('"${task_file}"');
    expect(script).toContain('"SES_INBOUND_SNS_TOPIC_ARN",');
    expect(script).toContain('"SES_INBOUND_SNS_TOPIC_ARNS",');
    expect(script).toContain(
      'required_environment["SES_EVENTS_SNS_TOPIC_ARN"] = ses_events_sns_topic_arn',
    );
    expect(script).toContain(
      'required_environment["SES_INBOUND_SNS_TOPIC_ARN"] = ses_inbound_sns_topic_arn',
    );
    expect(script).toContain(
      'required_environment["SES_INBOUND_SNS_TOPIC_ARNS"] = ses_inbound_sns_topic_arns',
    );
  });

  it("deploy script carries receiving storage config into the ingester task definition", () => {
    const script = readFileSync(join(root, "scripts", "deploy.sh"), "utf-8");
    expect(script).toContain("INGESTER_INBOUND_TOKEN_SECRET_ID");
    expect(script).toContain("ingester_inbound_token_secret_arn");
    expect(script).toContain('"name": "INGESTER_INBOUND_TOKEN"');
    expect(script).toContain('"SES_INBOUND_SNS_TOPIC_ARN",');
    expect(script).toContain('"SES_INBOUND_SNS_TOPIC_ARNS",');
    expect(script).toContain('"SES_INBOUND_BUCKET_NAME"');
    expect(script).toContain("app_task_definition");
  });

  it("deploy script wires every production ingester startup requirement", () => {
    const script = readFileSync(join(root, "scripts", "deploy.sh"), "utf-8");
    expect(script).toContain("UNSUBSCRIBE_SECRET_SECRET_ID");
    expect(script).toContain("unsubscribe_secret_secret_arn");
    expect(script).toContain("DKIM_ENCRYPTION_KEY_SECRET_ID");
    expect(script).toContain("dkim_encryption_key_secret_arn");
    expect(script).toContain('"name": "UNSUBSCRIBE_SECRET"');
    expect(script).toContain('"name": "DKIM_ENCRYPTION_KEY"');
    expect(script).toContain('"NEXT_PUBLIC_APP_URL"');
    expect(script).toContain('app_environment.get("APP_URL")');
    expect(script).toContain('app_environment.get("BETTER_AUTH_URL")');
    expect(script).toContain('"BETTER_AUTH_URL"');
  });

  it("deploy script runs migrations before ECS service redeploys", () => {
    const script = readFileSync(join(root, "scripts", "deploy.sh"), "utf-8");
    expect(script).toContain("bash scripts/deploy.sh migrate");
    expect(script).toContain("APP_MIGRATOR_TARGET");
    expect(script).toContain("aws ecs register-task-definition");
    expect(script).toContain("aws ecs run-task");

    const allDeployBlock = script.slice(
      script.indexOf("  all)"),
      script.indexOf("  *)"),
    );
    expect(allDeployBlock.indexOf("run_migrations")).toBeGreaterThan(-1);
    expect(allDeployBlock.indexOf("redeploy")).toBeGreaterThan(-1);
    expect(allDeployBlock.indexOf("run_migrations")).toBeLessThan(
      allDeployBlock.indexOf("redeploy"),
    );
  });

  it("has an idempotent repair migration for production domain columns", () => {
    const migration = readFileSync(
      join(root, "drizzle", "0010_repair_domain_columns.sql"),
      "utf-8",
    );
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "email_events"');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "received_emails"');
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS "webhook_deliveries"',
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "custom_return_path"',
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "tracking_subdomain"',
    );
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "capabilities"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "sent_at"');
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
  });

  it("package.json has build scripts for the app and ingester", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.scripts.build).toBe("next build");
    expect(pkg.scripts["build:ingester"]).toContain(
      "packages/ingester/src/server.ts",
    );
    expect(pkg.scripts["start:ingester"]).toBe(
      "bun ./packages/ingester/src/server.ts",
    );
  });

  it(".dockerignore excludes node_modules and .next", () => {
    const ignore = readFileSync(join(root, ".dockerignore"), "utf-8");
    expect(ignore).toContain("node_modules");
    expect(ignore).toContain(".next");
  });

  it("docker-compose pins release images for app, ingester, and scheduler by default", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf-8");
    const app = serviceBlock(compose, "app");
    const ingester = serviceBlock(compose, "ingester");
    const scheduler = serviceBlock(compose, "scheduler");

    expect(app).toContain("image: ghcr.io/namuh-eng/opensend:v1.0.0");
    expect(app).not.toContain("build:");
    expect(ingester).toContain(
      "image: ghcr.io/namuh-eng/opensend-ingester:v1.0.0",
    );
    expect(ingester).not.toContain("build:");
    expect(ingester).toContain("INGESTER_PORT:-3016");
    expect(ingester).toContain("http://127.0.0.1:3016/health");
    expect(scheduler).toContain(
      "image: ghcr.io/namuh-eng/opensend-ingester:v1.0.0",
    );
    expect(scheduler).toContain('command: ["bun", "/app/job-scheduler.js"]');
    expect(app).toContain(
      "DEDICATED_IP_OPERATOR_TOKEN: ${DEDICATED_IP_OPERATOR_TOKEN:-}",
    );
  });

  it("docker-compose local override builds the app and ingester from source", () => {
    const override = readFileSync(
      join(root, "docker-compose.local.yml"),
      "utf-8",
    );
    const app = serviceBlock(override, "app");
    const ingester = serviceBlock(override, "ingester");
    const scheduler = serviceBlock(override, "scheduler");

    expect(app).toContain("image: opensend:local");
    expect(app).toContain("target: runner");
    expect(ingester).toContain("image: opensend-ingester:local");
    expect(ingester).toContain("dockerfile: packages/ingester/Dockerfile");
    expect(scheduler).toContain("image: opensend-ingester:local");
    expect(scheduler).toContain("dockerfile: packages/ingester/Dockerfile");
  });

  it("docker-compose wires Redis-backed rate limiting by default", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf-8");
    expect(compose).toContain("redis:");
    expect(compose).toContain("image: redis:7-alpine");
    expect(compose).toContain("REDIS_URL: ${REDIS_URL:-redis://redis:6379}");
    expect(compose).toContain(
      "RATE_LIMIT_BACKEND: ${RATE_LIMIT_BACKEND:-redis}",
    );
    expect(compose).toContain(
      "OPENSEND_APP_REPLICAS: ${OPENSEND_APP_REPLICAS:-1}",
    );
    expect(compose).toContain("redisdata:");
  });

  it("docker-compose keeps the SMTP relay behind an explicit profile", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf-8");
    expect(compose).toContain("smtp-relay:");
    expect(compose).toContain('profiles: ["smtp"]');
    expect(compose).toContain("dockerfile: packages/smtp-relay/Dockerfile");
    expect(compose).toContain(
      '"${SMTP_RELAY_PORT:-2587}:${SMTP_RELAY_PORT:-2587}"',
    );
    expect(compose).not.toContain("smtp-relay:\n    image:");
  });

  it("ingester Dockerfile builds a standalone server bundle", () => {
    const dockerfile = readFileSync(
      join(root, "packages", "ingester", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("bun build ./packages/ingester/src/server.ts");
    expect(dockerfile).toContain("--outfile /tmp/ingester-server.js");
    expect(dockerfile).toContain("EXPOSE 3016");
    expect(dockerfile).toContain('CMD ["bun", "/app/server.js"]');
  });

  it("deploy fallback runbook documents the Mac mini outage break-glass path", () => {
    const runbookPath = join(
      root,
      "agent_docs",
      "runbooks",
      "deploy-fallback.md",
    );
    expect(existsSync(runbookPath)).toBe(true);
    const runbook = readFileSync(runbookPath, "utf-8");

    expect(runbook).toContain(".github/workflows/deploy.yml");
    expect(runbook).toContain("scripts/deploy.sh");
    expect(runbook).toContain("Mac mini runner outage");
    expect(runbook).toContain("self-hosted runner unavailability");
    expect(runbook).toContain("bun run deploy:fallback:preflight");
    expect(runbook).toContain("bash scripts/deploy.sh all");
    expect(runbook).toContain("no-op fallback deploy exercise");
    expect(runbook).toContain("not the Mac mini runner");
    expect(runbook).toContain("not proven fully closed");
  });

  it("deploy fallback preflight passes when app and ingester ECS services are ACTIVE", () => {
    const result = runPreflightWithServiceStatuses("ACTIVE", "ACTIVE");
    const output = `${result.stdout}
${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain(
      "[PASS] ECS services: found ACTIVE services: opensend-app, opensend-ingester",
    );
    expect(output).toContain(
      "[PASS] ECS scheduler service: opensend-scheduler status ACTIVE",
    );
    expect(output).toContain(
      "[PASS] Docker build platform: PLATFORM=linux/amd64",
    );
    expect(output).not.toContain("this-secret-value-must-not-appear");
  });

  it.each([
    {
      appStatus: "DRAINING" as const,
      ingesterStatus: "ACTIVE" as const,
      expected: "opensend-app status DRAINING",
    },
    {
      appStatus: "ACTIVE" as const,
      ingesterStatus: "INACTIVE" as const,
      expected: "opensend-ingester status INACTIVE",
    },
  ])(
    "deploy fallback preflight fails when an ECS service is $expected",
    ({ appStatus, ingesterStatus, expected }) => {
      const result = runPreflightWithServiceStatuses(appStatus, ingesterStatus);
      const output = `${result.stdout}
${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("[FAIL] ECS services");
      expect(output).toContain(expected);
      expect(output).toContain(
        "services must be ACTIVE before fallback deploy",
      );
      expect(output).not.toContain("this-secret-value-must-not-appear");
    },
  );

  it.each([
    {
      schedulerStatus: "ACTIVE" as const,
      expected: "opensend-scheduler status ACTIVE",
    },
    {
      schedulerStatus: "ABSENT" as const,
      expected: "opensend-scheduler is absent; deploy will create it",
    },
  ])(
    "deploy fallback preflight passes when the scheduler service is $schedulerStatus",
    ({ schedulerStatus, expected }) => {
      const result = runPreflightWithServiceStatuses("ACTIVE", "ACTIVE", {
        schedulerStatus,
      });
      const output = `${result.stdout}
${result.stderr}`;

      expect(result.status).toBe(0);
      expect(output).toContain("[PASS] ECS scheduler service");
      expect(output).toContain(expected);
      expect(output).not.toContain("this-secret-value-must-not-appear");
    },
  );

  it.each([
    {
      schedulerStatus: "DRAINING" as const,
      expected:
        "opensend-scheduler must be ACTIVE or absent before fallback deploy; status DRAINING",
    },
    {
      schedulerStatus: "INACTIVE" as const,
      expected:
        "opensend-scheduler must be ACTIVE or absent before fallback deploy; status INACTIVE",
    },
  ])(
    "deploy fallback preflight fails when the scheduler service is $schedulerStatus",
    ({ schedulerStatus, expected }) => {
      const result = runPreflightWithServiceStatuses("ACTIVE", "ACTIVE", {
        schedulerStatus,
      });
      const output = `${result.stdout}
${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("[FAIL] ECS scheduler service");
      expect(output).toContain(expected);
      expect(output).not.toContain("this-secret-value-must-not-appear");
    },
  );

  it("deploy fallback preflight fails when PLATFORM is not linux/amd64", () => {
    const result = runPreflightWithServiceStatuses("ACTIVE", "ACTIVE", {
      platform: "linux/arm64",
    });
    const output = `${result.stdout}
${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("[FAIL] Docker build platform");
    expect(output).toContain(
      "PLATFORM must be linux/amd64 for production fallback deploys; got linux/arm64",
    );
    expect(output).not.toContain("this-secret-value-must-not-appear");
  });

  it("deploy fallback preflight checks production reachability and Docker ECR auth without pushing", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    expect(pkg.scripts["deploy:fallback:preflight"]).toBe(
      "bun tools/deploy-fallback-preflight.ts",
    );

    const preflight = readFileSync(
      join(root, "tools", "deploy-fallback-preflight.ts"),
      "utf-8",
    );

    expect(preflight).toContain("docker");
    expect(preflight).toContain("buildx");
    expect(preflight).toContain('const region = env.AWS_REGION || "us-east-1"');
    expect(preflight).not.toContain("AWS_DEFAULT_REGION");
    expect(preflight).toContain('"bun", ["--version"]');
    expect(preflight).toContain('"python3", ["--version"]');
    expect(preflight).toContain(
      'const platform = env.PLATFORM || "linux/amd64"',
    );
    expect(preflight).toContain("platformCheck");
    expect(preflight).toContain(
      "PLATFORM must be linux/amd64 for production fallback deploys",
    );
    expect(preflight).toContain("get-caller-identity");
    expect(preflight).toContain("get-login-password");
    expect(preflight).toContain("dockerEcrLoginCheck");
    expect(preflight).toContain(
      '"login", "--username", "AWS", "--password-stdin"',
    );
    expect(preflight).toContain("describe-repositories");
    expect(preflight).toContain("describe-services");
    expect(preflight).toContain("ecsServicesActiveCheck");
    expect(preflight).toContain("ecsSchedulerServiceActiveOrAbsentCheck");
    expect(preflight).toContain("schedulerService");
    expect(preflight).toContain(
      "services[].{serviceName:serviceName,status:status}",
    );
    expect(preflight).toContain(
      "{services:services[].{serviceName:serviceName,status:status},failures:failures[].{arn:arn,reason:reason}}",
    );
    expect(preflight).toContain(
      "must be ACTIVE or absent before fallback deploy",
    );
    expect(preflight).toContain(
      "services must be ACTIVE before fallback deploy",
    );
    expect(preflight).toContain("status ${service.status}");
    expect(preflight).toContain("describe-task-definition");
    expect(preflight).toContain("ecsTaskDefinitionMetadataCheck");
    expect(preflight).toContain("taskDefinition.family");
    expect(preflight).toContain(
      "containerDefinitions[].{name:name,secrets:secrets[].name,environment:environment[].name}",
    );
    expect(preflight).toContain("appContainerName");
    expect(preflight).toContain("ingesterContainerName");
    expect(preflight).toContain("requiredContainerSecretNames");
    expect(preflight).toContain("requiredContainerEnvironmentOrSecretNames");
    expect(preflight).toContain("appStartupRequiredEnvironmentOrSecretNames");
    expect(preflight).toContain(`ecsTaskDefinitionMetadataCheck(
      appService,
      appContainerName,
      [],
      appStartupRequiredEnvironmentOrSecretNames,
    )`);
    expect(preflight).toContain("environmentNames.has(name)");
    expect(preflight).toContain("secretNames.has(name)");
    expect(preflight).toContain(
      "ingesterStartupRequiredEnvironmentOrSecretNames",
    );
    expect(preflight).toContain("DATABASE_URL");
    expect(preflight).toContain("BETTER_AUTH_URL");
    expect(preflight).toContain("NEXT_PUBLIC_APP_URL");
    expect(preflight).toContain("BETTER_AUTH_SECRET");
    expect(preflight).toContain("WEBHOOK_SECRET_ENCRYPTION_KEY");
    expect(preflight).toContain("INGESTER_JOB_TOKEN");
    expect(preflight).toContain("INGESTER_INBOUND_TOKEN");
    expect(preflight).toContain("TRACKING_SECRET");
    expect(preflight).toContain("UNSUBSCRIBE_SECRET");
    expect(preflight).toContain("DKIM_ENCRYPTION_KEY");
    expect(preflight).toContain("BETTER_AUTH_TRUSTED_ORIGINS");
    expect(preflight).toContain("missing required secret metadata");
    expect(preflight).toContain(
      "missing required environment or secret metadata",
    );
    expect(preflight).toContain(
      "App startup required environment/secret metadata",
    );
    expect(preflight).toContain("Scheduler base task required secret metadata");
    expect(preflight).toContain(
      "Ingester startup required environment/secret metadata",
    );
    expect(preflight).toContain("describe-secret");
    expect(preflight).toContain("WEBHOOK_SECRET_ENCRYPTION_KEY_SECRET_ID");
    expect(preflight).toContain("WEBHOOK_SECRET_ENCRYPTION_KEY_SECRET_ARN");
    expect(preflight).toContain("TRACKING_SECRET_SECRET_ID");
    expect(preflight).toContain("TRACKING_SECRET_SECRET_ARN");
    expect(preflight).toContain("INGESTER_JOB_TOKEN_SECRET_ID");
    expect(preflight).toContain("INGESTER_JOB_TOKEN_SECRET_ARN");
    expect(preflight).toContain("INGESTER_INBOUND_TOKEN_SECRET_ID");
    expect(preflight).toContain("INGESTER_INBOUND_TOKEN_SECRET_ARN");
    expect(preflight).toContain("UNSUBSCRIBE_SECRET_SECRET_ID");
    expect(preflight).toContain("UNSUBSCRIBE_SECRET_SECRET_ARN");
    expect(preflight).toContain("DKIM_ENCRYPTION_KEY_SECRET_ID");
    expect(preflight).toContain("DKIM_ENCRYPTION_KEY_SECRET_ARN");
    expect(preflight).toContain("Required secret metadata");
    expect(preflight).toContain("the password is not printed");
    expect(preflight).not.toContain("Optional Secrets Manager metadata");
    expect(preflight).toContain("Secret values are not fetched or printed");
    expect(preflight).not.toContain("env.APP_REPO");
    expect(preflight).not.toContain("env.ING_REPO");
    expect(preflight).not.toContain("env.APP_SERVICE");
    expect(preflight).not.toContain("env.ING_SERVICE");

    expect(preflight).not.toContain("environment[].value");
    expect(preflight).not.toContain("get-secret-value");
    expect(preflight).not.toContain("update-service");
    expect(preflight).not.toContain("register-task-definition");
    expect(preflight).not.toContain("run-task");
    expect(preflight).not.toContain("buildx build");
    expect(preflight).not.toContain("--push");
    expect(preflight).not.toContain("get-secret-value");

    const runbook = readFileSync(
      join(root, "agent_docs", "runbooks", "deploy-fallback.md"),
      "utf-8",
    );
    expect(runbook).toContain("aws ecr get-login-password");
    expect(runbook).toContain("bun --version");
    expect(runbook).toContain("If Bun is missing");
    expect(runbook).toContain("python3 --version");
    expect(runbook).toContain("docker login --password-stdin");
    expect(runbook).toContain("does not print the password");
    expect(runbook).toContain("does not push images");
    expect(runbook).toContain("current task definitions");
    expect(runbook).toContain("services report `ACTIVE` status");
    expect(runbook).toContain(
      "scheduler service is either absent or reports `ACTIVE` status",
    );
    expect(runbook).toContain("`DRAINING` or `INACTIVE`");
    expect(runbook).toContain("service/status");
    expect(runbook).toContain("expected app and ingester containers");
    expect(runbook).toContain(
      "app task definition includes the production app startup-required environment or secret metadata names",
    );
    expect(runbook).toContain("DATABASE_URL");
    expect(runbook).toContain("BETTER_AUTH_URL");
    expect(runbook).toContain("NEXT_PUBLIC_APP_URL");
    expect(runbook).toContain("BETTER_AUTH_SECRET");
    expect(runbook).toContain("BETTER_AUTH_TRUSTED_ORIGINS");
    expect(runbook).toContain("WEBHOOK_SECRET_ENCRYPTION_KEY");
    expect(runbook).toContain("INGESTER_JOB_TOKEN");
    expect(runbook).toContain("INGESTER_INBOUND_TOKEN");
    expect(runbook).toContain("TRACKING_SECRET");
    expect(runbook).toContain("UNSUBSCRIBE_SECRET");
    expect(runbook).toContain("DKIM_ENCRYPTION_KEY");
    expect(runbook).toContain("scheduler base task");
    expect(runbook).toContain(
      "startup-required environment or secret metadata",
    );
    expect(runbook).toContain("packages/ingester/src/startup-checks.ts");
    expect(runbook).toContain("checks names only");
    expect(runbook).toContain(
      "Bun is available to run the repository preflight command",
    );
    expect(runbook).toContain("does write/refresh the local Docker ECR login");
    expect(runbook).toContain("`PLATFORM` must be `linux/amd64`");
    expect(runbook).toContain("TRACKING_SECRET_SECRET_ID");
    expect(runbook).toContain("INGESTER_JOB_TOKEN_SECRET_ID");
    expect(runbook).toContain("INGESTER_INBOUND_TOKEN_SECRET_ID");
    expect(runbook).toContain("ingester inbound token");
    expect(runbook).not.toContain(
      "checked by preflight only when explicitly set",
    );
    expect(runbook).toContain(
      "ECR repository and ECS service names are derived",
    );
    expect(runbook).not.toContain("APP_REPO");
    expect(runbook).not.toContain("ING_REPO");
    expect(runbook).not.toContain("APP_SERVICE");
    expect(runbook).not.toContain("ING_SERVICE");
  });

  it("ingester runbook captures the split deploy and operational steps", () => {
    const runbookPath = join(root, "docs", "ingester-deploy.md");
    expect(existsSync(runbookPath)).toBe(true);
    const runbook = readFileSync(runbookPath, "utf-8");
    expect(runbook).toContain("SES SNS should point at");
    expect(runbook).toContain("aws logs tail");
    expect(runbook).toContain("curl -i");
  });
});
