# PowerHub — Admin-configurable Trial Policy

## Rule

The trial period is configurable by a Platform Admin when creating a customer subscription. It is not hard-coded to 8 days.

- Default value: 8 days.
- Admin may choose another positive duration.
- Trial end is calculated from the subscription start time.
- Trial subscriptions do not auto-renew unless a future explicit commercial flow enables it.
- Expired trial access is enforced by the backend subscription gate.

## Examples

- 8 days → normal launch default.
- 14 days → extended evaluation.
- 30 days → special commercial trial.

## Safety

The duration must be validated server-side as a positive integer. UI validation alone is insufficient.
