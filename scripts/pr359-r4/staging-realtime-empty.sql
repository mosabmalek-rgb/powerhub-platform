-- Read-only and metadata-free count of the managed Realtime parent including
-- daily child partitions. Nonzero data forbids Staging lifecycle exceptions.
SELECT count(*)::bigint FROM realtime.messages;
