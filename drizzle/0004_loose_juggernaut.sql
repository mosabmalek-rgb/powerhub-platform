ALTER TABLE `auditLogs` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `auditLogs` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `auditLogs` ADD `siteId` int;--> statement-breakpoint
ALTER TABLE `auditLogs` ADD CONSTRAINT `auditLogs_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auditLogs` ADD CONSTRAINT `auditLogs_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_tenant_site_date_idx` ON `auditLogs` (`tenantId`,`siteId`,`createdAt`);
