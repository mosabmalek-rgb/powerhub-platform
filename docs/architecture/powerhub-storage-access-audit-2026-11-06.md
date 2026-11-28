# PowerHub Storage access audit — 6 November 2026

## Scope

Read-only inspection of Supabase Staging project `iyuryuhaylhisjfcrwkz` and
source at commit `c5c27a87b50fc8b6f89f59db3732758d53120163`. The review
covers the private bucket, Storage object RLS, chat attachment metadata,
server-side upload/signing/removal call sites, and retention claims.

No Storage objects, policies, bucket settings, database rows, Cron jobs, or
Production resources were changed during the inspection.

## Observed Staging state

- `powerhub-private` exists and is private (`public = false`).
- There are zero objects in the bucket.
- There are zero chat attachment rows and zero chat-prefixed objects.
- There are zero unresolved chat attachment references.
- There are zero retention claims and zero active retention leases.
- `storage.objects` has RLS enabled.
- The only current object policy is `chat_storage_select_conversation_access`,
  restricted to `authenticated`. It requires an attachment metadata row,
  an exact bucket/path match, and the private conversation authorization
  helper.
- There are no INSERT, UPDATE, or DELETE policies on `storage.objects`.
- Effective SQL table grants still include SELECT/INSERT/UPDATE/DELETE for
  `anon` and `authenticated`. RLS currently blocks direct browser mutations
  because no write policies exist. The broad underlying grants are a
  least-privilege follow-up, not proof that those writes currently succeed.
- The bucket's `file_size_limit` and `allowed_mime_types` are NULL. This
  differs from the repository's original bucket migration, which specifies a
  10 MiB maximum and JPEG, PNG, WEBP, and PDF. The bucket is empty, so no
  existing object is affected by correcting the configuration.

## Source and authorization review

The common server adapter is `server/storage.ts`. Uploads use
`upsert: false`; signed URLs have a 10-minute TTL; keys reject traversal,
backslashes, empty path components, and oversized names.

Important signed-URL call sites were checked:

- Reading images: verify the user's site membership, fetch the reading under
  the tenant scope, then verify the subscriber belongs to the requested site.
- Payment receipts: require the collection capability and match tenant, site,
  and payment ID before signing.
- Payment-documentation receipts: require the approval capability and feature
  entitlement, then match tenant, site, and request ID.
- Subscriber portal branding: resolve an enabled portal and its tenant
  entitlement before signing the logo.
- Report branding: owner-level site authorization is checked before resolving
  the stored report logo.
- Chat Storage: browser reads use the attachment metadata RLS policy and the
  `private.chat_rls_can_select_conversation` authorization helper. Direct
  browser uploads and mutations are not enabled by the current object policy.

The common adapter is a privileged service-role boundary. It must only be
called after the application/database authorization checks above; it must not
be exposed as an arbitrary path signing endpoint.

## Changes in this source update

The common upload adapter now:

- permits only `image/jpeg`, `image/png`, `image/webp`, and
  `application/pdf`;
- normalizes MIME parameters and case;
- validates JPEG, PNG, WEBP, and PDF file signatures against the declared
  MIME type;
- rejects empty payloads;
- rejects payloads larger than 10 MiB before calling Storage;
- keeps unique object names and `upsert: false`;
- retains the existing private bucket and 10-minute signed URL behavior.

These checks are application-side defense in depth. Signature checks are not
a complete content parser, malware scanner, or image re-encoder. The Supabase
bucket must also be configured with the matching size and MIME restrictions.

## Regression test added

`supabase/tests/storage_object_rls_isolation.sql` creates an isolated
PostgreSQL contract test for:

1. A tenant member can read their own chat attachment object.
2. Changing tenant context does not expose another tenant's object.
3. Anonymous users cannot read private objects.
4. Authenticated browser users cannot insert, overwrite, or delete objects
   directly.
5. The server-side `service_role` retains its intended Storage access.

The test is wired into Reading Cycle PostgreSQL Integration and runs only in
the disposable CI PostgreSQL service.

## Migration-history reconciliation is a separate gate

The Staging migration history contains 410 records. Comparing it to the current
repository tree found substantial historical naming/version divergence:
several applied records have matching migration names but different source
timestamps, and some records do not have a same-named file in the current tree.
The Staging chat Storage policy records, for example, use recorded versions
`20260914100844` and `20260914100913`, while the corresponding current
source filenames use `20260914150000` and `20260914150500`.

The private bucket exists despite the original `0007_powerhub_private_storage`
file not appearing by that filename in Staging history. This strongly suggests
historical replay/renaming or manual provisioning and must not be "fixed" by
blindly replaying the old migration.

Therefore:

- Do not apply `0007_powerhub_private_storage.sql` directly to Staging.
- Do not reapply chat Storage RLS migrations.
- Do not rename already-applied migration records just to match the current
  filenames.
- First establish a canonical mapping by migration name, source content,
  recorded version, and resulting database objects.
- Only after that review, create a new forward-only bucket-configuration
  migration with the Supabase CLI's migration generator and apply it to
  Staging. It should set the 10 MiB limit and the approved MIME allow-list,
  without deleting or replacing objects.

## Remaining gates

1. Reconcile the Staging migration history before issuing any new schema
   migration.
2. Apply the new bucket size/MIME configuration to Staging and verify it
   directly.
3. Revoke excess browser SQL grants on `storage.objects` only after proving
   the Storage API's service-role/control-plane behavior remains functional.
4. Complete object-read authorization tests for all receipt and reading paths,
   not only chat.
5. Keep Production unchanged until an independent review and explicit
   release approval.

## Current conclusion

The existing private bucket is empty, and the current chat read policy is
metadata- and tenant-authorized. No direct browser Storage write policy is
present. The app-side upload validator and disposable PostgreSQL RLS test
strengthen the source contract. Bucket-level MIME/size limits and migration
history reconciliation remain open operational items; no Staging or
Production database mutation was performed as part of this source review.
