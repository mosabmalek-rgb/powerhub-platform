ALTER TABLE `auditLogs` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `auditLogs` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `auditLogs` MODIFY COLUMN `siteId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `notificationMessages` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` MODIFY COLUMN `tenantId` int NOT NULL;
