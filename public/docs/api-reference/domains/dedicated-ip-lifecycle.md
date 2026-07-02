# Dedicated IP lifecycle

Dedicated IP pool APIs let tenants request a dedicated IP pool and track it through its full lifecycle. Once a tenant's request is submitted, an operator approves it via the internal endpoint — at which point OpenSend automatically provisions an AWS SES MANAGED dedicated IP pool and begins reconciling its warmup state via the background scheduler.

> **Billing note:** SES MANAGED pools accrue AWS charges from the moment the operator approval endpoint fires. Operators must review usage volume before approving. OpenSend emits a `volume_warning` flag in the approve response when the tenant's most recent billing period sent fewer than 50 000 emails.

## Status lifecycle

```
requested → provisioned → warming → active → suspended | retired
                        ↘ active   (MANAGED pools skip warming)
```

| Status | Meaning |
|---|---|
| `requested` | Tenant has submitted a request; awaiting operator review |
| `provisioned` | SES pool created; awaiting IP assignment |
| `warming` | IPs assigned (STANDARD mode); warmup in progress |
| `active` | Pool ready to send |
| `suspended` | Sending paused by operator |
| `retired` | Pool decommissioned; SES pool deleted |

The `/jobs/dedicated-ip-sync` background job (runs on the ingester scheduler) polls SES for pools in `provisioned` or `warming` state and advances them automatically.

---

## Endpoints

### List dedicated IP pools

```http
GET /api/dedicated-ips
Authorization: Bearer <api_key>
```

Returns all pools for the authenticated tenant.

**Response**

```json
{
  "object": "list",
  "data": [
    {
      "object": "dedicated_ip_pool",
      "id": "dip_...",
      "name": "My production pool",
      "provider": "ses",
      "provider_pool_name": "opensend-ab12cd34-ef56ab78",
      "ses_pool_name": "opensend-ab12cd34-ef56ab78",
      "scaling_mode": "MANAGED",
      "status": "active",
      "operator_notes": null,
      "ip_count": 1,
      "aws_region": "us-east-1",
      "provisioned_at": "2026-06-01T00:00:00Z",
      "warming_started_at": null,
      "retired_at": null,
      "created_at": "2026-05-28T00:00:00Z",
      "updated_at": "2026-06-01T00:00:00Z"
    }
  ]
}
```

---

### Create dedicated IP pool

```http
POST /api/dedicated-ips
Authorization: Bearer <api_key>
Content-Type: application/json
```

Creates a lifecycle record with status `requested`. Does **not** provision the SES pool — that requires operator approval (see below).

**Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Human-readable name (max 255 chars) |
| `scaling_mode` | `"MANAGED"` \| `"STANDARD"` | no | Default `"MANAGED"` |
| `provider_pool_name` | string | no | Manual lifecycle metadata only; operator approval always provisions an OpenSend-generated SES pool name |

**Response** — `201 Created`

The new pool object with `status: "requested"`.

---

### Get dedicated IP pool

```http
GET /api/dedicated-ips/{id}
Authorization: Bearer <api_key>
```

**Response** — `200 OK` or `404`

The pool object (same shape as list entries above).

---

### Update dedicated IP pool

```http
PATCH /api/dedicated-ips/{id}
Authorization: Bearer <api_key>
Content-Type: application/json
```

Updates mutable fields. If `status` is set to `"retired"` and the pool has `provider: "ses"`, OpenSend calls `DeleteDedicatedIpPool` in SES first (best-effort; failure is logged but does not block the status update).

**Body**

| Field | Type | Description |
|---|---|---|
| `name` | string | Rename the pool |
| `status` | lifecycle status | Advance or roll back lifecycle state |
| `provider_pool_name` | string \| null | Override the SES pool name before SES provisioning; immutable after `provider: "ses"` |
| `scaling_mode` | `"MANAGED"` \| `"STANDARD"` | Change scaling mode |
| `operator_notes` | string \| null | Internal operator annotations (max 4000 chars) |

---

### Delete (retire) dedicated IP pool

```http
DELETE /api/dedicated-ips/{id}
Authorization: Bearer <api_key>
```

Sets `status: "retired"` and `retired_at: now`. If the pool has `provider: "ses"`, OpenSend calls `DeleteDedicatedIpPool` in SES first (best-effort).

**Response** — `200 OK`

```json
{
  "object": "dedicated_ip_pool",
  "id": "dip_...",
  "retired": true,
  "status": "retired"
}
```

---

### Approve and provision (operator-only)

```http
POST /api/internal/dedicated-ips/{id}/approve
Authorization: Bearer <DEDICATED_IP_OPERATOR_TOKEN>
Content-Type: application/json
```

Operator-only gate. Validates the pool is in `requested` status, then calls AWS SES `CreateDedicatedIpPool` and advances the record to `provisioned`. Requires the `DEDICATED_IP_OPERATOR_TOKEN` env var to be set on the server.

**Body**

| Field | Type | Description |
|---|---|---|
| `aws_region` | string | SES region (default `"us-east-1"`, max 32 chars) |
| `operator_notes` | string | Notes recorded on the pool record (max 4000 chars) |

**Response** — `200 OK`

```json
{
  "object": "dedicated_ip_pool",
  "id": "dip_...",
  "status": "provisioned",
  "volume_warning": true,
  "emails_sent": 12000
}
```

`volume_warning: true` means the tenant's last billing period sent fewer than 50 000 emails. SES recommends at least that volume for a MANAGED dedicated IP to warm correctly. The approval is not blocked — this is advisory only.

**Error responses**

| Status | `code` | Meaning |
|---|---|---|
| `401` | — | Missing or invalid `DEDICATED_IP_OPERATOR_TOKEN` |
| `404` | — | Pool not found |
| `409` | `invalid_status` | Pool is not in `requested` status; `current_status` in body |
| `422` | — | Body validation failed |

---

## Plan gating

Creating a pool requires the tenant to be on a plan that includes the dedicated IP add-on. A `403 Forbidden` with `error: "plan_feature_not_available"` is returned otherwise.

---

## Background sync

The `dedicated-ip-sync` ingester job runs on the configured `INGESTER_SCHEDULER_INTERVAL_SECONDS` cadence. It:

1. Loads all pools in `provisioned` or `warming` status.
2. Calls `GetDedicatedIps` (paginated, up to 1000 IPs) for each pool's SES pool name.
3. Updates `ip_count` and `last_synced_at`.
4. Advances status:
   - `provisioned` + IPs present + scaling mode `MANAGED` + none `IN_PROGRESS` → `active` (skips warming)
   - `provisioned` + IPs present + `STANDARD` → `warming`
   - `warming` + all IPs non-`IN_PROGRESS` → `active`

Pools synced fewer than 5 minutes ago are skipped to avoid thrashing the SES API.
