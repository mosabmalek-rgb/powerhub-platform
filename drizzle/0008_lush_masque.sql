CREATE TABLE `collectorSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int NOT NULL,
	`collectorUserId` int NOT NULL,
	`status` enum('open','closed') NOT NULL DEFAULT 'open',
	`openingCash` decimal(14,2) NOT NULL DEFAULT '0',
	`expectedCash` decimal(14,2) NOT NULL DEFAULT '0',
	`declaredCash` decimal(14,2),
	`varianceAmount` decimal(14,2),
	`openedAt` timestamp NOT NULL DEFAULT (now()),
	`closedAt` timestamp,
	`notes` text,
	`closedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `collectorSessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `payments` ADD `collectorSessionId` int;--> statement-breakpoint
ALTER TABLE `collectorSessions` ADD CONSTRAINT `collectorSessions_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collectorSessions` ADD CONSTRAINT `collectorSessions_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collectorSessions` ADD CONSTRAINT `collectorSessions_collectorUserId_users_id_fk` FOREIGN KEY (`collectorUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collectorSessions` ADD CONSTRAINT `collectorSessions_closedByUserId_users_id_fk` FOREIGN KEY (`closedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `collector_sessions_tenant_site_idx` ON `collectorSessions` (`tenantId`,`siteId`,`status`);--> statement-breakpoint
CREATE INDEX `collector_sessions_collector_status_idx` ON `collectorSessions` (`collectorUserId`,`status`);--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_collectorSessionId_collectorSessions_id_fk` FOREIGN KEY (`collectorSessionId`) REFERENCES `collectorSessions`(`id`) ON DELETE no action ON UPDATE no action;