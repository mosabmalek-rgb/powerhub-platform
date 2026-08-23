CREATE TABLE `mobileSyncEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`sessionId` int,
	`eventKey` varchar(128) NOT NULL,
	`eventType` enum('sync_cycle','sync_error') NOT NULL,
	`status` enum('success','partial','retryable','needs_review','failed') NOT NULL,
	`syncedCount` int NOT NULL DEFAULT 0,
	`retryableCount` int NOT NULL DEFAULT 0,
	`needsReviewCount` int NOT NULL DEFAULT 0,
	`errorCode` varchar(100),
	`errorMessage` text,
	`appVersion` varchar(64),
	`deviceLabel` varchar(160),
	`metadata` json,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mobileSyncEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `mobile_sync_events_tenant_event_key_unique` UNIQUE(`tenantId`,`eventKey`)
);
--> statement-breakpoint
ALTER TABLE `mobileSyncEvents` ADD CONSTRAINT `mobileSyncEvents_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mobileSyncEvents` ADD CONSTRAINT `mobileSyncEvents_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mobileSyncEvents` ADD CONSTRAINT `mobileSyncEvents_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mobileSyncEvents` ADD CONSTRAINT `mobileSyncEvents_sessionId_mobileApiSessions_id_fk` FOREIGN KEY (`sessionId`) REFERENCES `mobileApiSessions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mobile_sync_events_tenant_site_date_idx` ON `mobileSyncEvents` (`tenantId`,`siteId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `mobile_sync_events_tenant_user_date_idx` ON `mobileSyncEvents` (`tenantId`,`userId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `mobile_sync_events_site_status_date_idx` ON `mobileSyncEvents` (`siteId`,`status`,`occurredAt`);