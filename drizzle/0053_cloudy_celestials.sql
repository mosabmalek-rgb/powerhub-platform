CREATE TABLE `offlineSyncOperations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`clientOperationId` varchar(80) NOT NULL,
	`operationType` enum('subscriber_create','subscriber_update','invoice_issue') NOT NULL,
	`entityType` varchar(80) NOT NULL,
	`entityId` int NOT NULL,
	`response` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `offlineSyncOperations_id` PRIMARY KEY(`id`),
	CONSTRAINT `offline_sync_actor_operation_unique` UNIQUE(`userId`,`clientOperationId`)
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `clientOperationId` varchar(80);--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoice_client_operation_unique` UNIQUE(`clientOperationId`);--> statement-breakpoint
ALTER TABLE `offlineSyncOperations` ADD CONSTRAINT `offlineSyncOperations_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offlineSyncOperations` ADD CONSTRAINT `offlineSyncOperations_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `offlineSyncOperations` ADD CONSTRAINT `offlineSyncOperations_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `offline_sync_tenant_site_created_idx` ON `offlineSyncOperations` (`tenantId`,`siteId`,`createdAt`);