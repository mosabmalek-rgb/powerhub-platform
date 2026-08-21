ALTER TABLE `staffProfiles` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `staffProfiles` ADD CONSTRAINT `staffProfiles_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `staff_tenant_site_active_idx` ON `staffProfiles` (`tenantId`,`siteId`,`isActive`);