CREATE TABLE `sitePortalSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`siteId` int NOT NULL,
	`portalCode` varchar(50) NOT NULL,
	`displayName` varchar(160),
	`primaryColor` varchar(20) NOT NULL DEFAULT '#0D1117',
	`accentColor` varchar(20) NOT NULL DEFAULT '#F5B800',
	`isEnabled` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sitePortalSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_portal_settings_site_unique` UNIQUE(`siteId`),
	CONSTRAINT `site_portal_settings_code_unique` UNIQUE(`portalCode`)
);
--> statement-breakpoint
ALTER TABLE `sitePortalSettings` ADD CONSTRAINT `sitePortalSettings_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sitePortalSettings` ADD CONSTRAINT `sitePortalSettings_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `site_portal_settings_tenant_idx` ON `sitePortalSettings` (`tenantId`);