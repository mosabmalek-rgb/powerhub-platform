# PowerHub SLA / SLO Baseline

This is the initial operational baseline for production. It is not a contractual SLA until published and approved commercially.

## SLO targets

| Service indicator | Initial target | Measurement |
|---|---:|---|
| Production availability | >= 99.5% monthly | Vercel production health / synthetic checks |
| HTTP 5xx rate | < 1% monthly | Vercel runtime logs |
| Critical financial operation success | >= 99.9% | RPC/application telemetry |
| Critical security incidents | 0 | Security and audit review |
| Tenant-isolation violations | 0 | Automated security tests + audit |
| Recovery acknowledgement | <= 15 min for SEV-1 | Incident timeline |

## Operational review
- Review SLOs monthly.
- Review error-rate and latency trends before changing targets.
- Establish formal RTO/RPO only after the backup/restore capability is tested.
- Do not treat the baseline as a customer-facing contractual guarantee without commercial approval.
