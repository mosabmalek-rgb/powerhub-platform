/**
 * Shared type/error exports that are independent from any database adapter.
 *
 * Database row types belong to their owning domain/adaptor module and must not
 * leak the legacy Drizzle schema into shared application code.
 */

export * from "./_core/errors";
