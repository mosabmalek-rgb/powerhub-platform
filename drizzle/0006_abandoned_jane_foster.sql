ALTER TABLE `generators` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `subscribers` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `meters` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `tariffs` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `meterReadings` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `invoices` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `invoiceLines` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `invoiceShareLinks` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `payments` ADD `tenantId` int;--> statement-breakpoint
ALTER TABLE `expenses` ADD `tenantId` int;--> statement-breakpoint
UPDATE `generators` g INNER JOIN `sites` s ON s.`id` = g.`siteId` SET g.`tenantId` = s.`tenantId`;--> statement-breakpoint
UPDATE `subscribers` sbr INNER JOIN `sites` s ON s.`id` = sbr.`siteId` SET sbr.`tenantId` = s.`tenantId`;--> statement-breakpoint
UPDATE `meters` m INNER JOIN `subscribers` sbr ON sbr.`id` = m.`subscriberId` SET m.`tenantId` = sbr.`tenantId`;--> statement-breakpoint
UPDATE `tariffs` t INNER JOIN `sites` s ON s.`id` = t.`siteId` SET t.`tenantId` = s.`tenantId`;--> statement-breakpoint
UPDATE `meterReadings` r INNER JOIN `meters` m ON m.`id` = r.`meterId` SET r.`tenantId` = m.`tenantId`;--> statement-breakpoint
UPDATE `invoices` i INNER JOIN `sites` s ON s.`id` = i.`siteId` SET i.`tenantId` = s.`tenantId`;--> statement-breakpoint
UPDATE `invoiceLines` l INNER JOIN `invoices` i ON i.`id` = l.`invoiceId` SET l.`tenantId` = i.`tenantId`;--> statement-breakpoint
UPDATE `invoiceShareLinks` sl INNER JOIN `invoices` i ON i.`id` = sl.`invoiceId` SET sl.`tenantId` = i.`tenantId`;--> statement-breakpoint
UPDATE `payments` p INNER JOIN `sites` s ON s.`id` = p.`siteId` SET p.`tenantId` = s.`tenantId`;--> statement-breakpoint
UPDATE `expenses` e INNER JOIN `sites` s ON s.`id` = e.`siteId` SET e.`tenantId` = s.`tenantId`;--> statement-breakpoint
ALTER TABLE `generators` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `subscribers` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `meters` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `tariffs` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `meterReadings` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `invoiceLines` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `invoiceShareLinks` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` MODIFY COLUMN `tenantId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `generators` ADD CONSTRAINT `generators_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscribers` ADD CONSTRAINT `subscribers_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meters` ADD CONSTRAINT `meters_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tariffs` ADD CONSTRAINT `tariffs_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meterReadings` ADD CONSTRAINT `meterReadings_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceLines` ADD CONSTRAINT `invoiceLines_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceShareLinks` ADD CONSTRAINT `invoiceShareLinks_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `generators_tenant_site_idx` ON `generators` (`tenantId`,`siteId`);--> statement-breakpoint
CREATE INDEX `subscribers_tenant_site_idx` ON `subscribers` (`tenantId`,`siteId`);--> statement-breakpoint
CREATE INDEX `tariffs_tenant_site_idx` ON `tariffs` (`tenantId`,`siteId`);--> statement-breakpoint
CREATE INDEX `invoices_tenant_site_idx` ON `invoices` (`tenantId`,`siteId`);--> statement-breakpoint
CREATE INDEX `payments_tenant_site_idx` ON `payments` (`tenantId`,`siteId`);--> statement-breakpoint
CREATE INDEX `expenses_tenant_site_idx` ON `expenses` (`tenantId`,`siteId`);
