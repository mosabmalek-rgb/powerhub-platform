# Visible feature contract — bulk messaging and owner workflows

- Bulk invoice SMS accepts explicit selections or sendAll; server-side processing is internally batched at 50 for provider safety without imposing a user-facing batch limit.
- Failed SMS can be retried explicitly through the failed-only workflow.
- Owner usage alerts are durable Supabase records and appear in the owner's workspace with read tracking.
- Subaccount creation uses Supabase Auth, the existing profile trigger, and the tenant-scoped staff assignment RPC; failures compensate by deleting the newly created Auth user.
