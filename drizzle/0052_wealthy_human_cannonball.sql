ALTER TABLE `invoices` DROP FOREIGN KEY `invoices_meterId_meters_id_fk`;--> statement-breakpoint
ALTER TABLE `invoices` DROP INDEX `invoice_meter_period_unique`;
--> statement-breakpoint
ALTER TABLE `meterReadings` DROP FOREIGN KEY `meterReadings_meterId_meters_id_fk`;
--> statement-breakpoint
DROP INDEX `readings_meter_date_idx` ON `meterReadings`;--> statement-breakpoint
ALTER TABLE `meterReadings` ADD `subscriberId` int NOT NULL;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoice_subscriber_period_unique` UNIQUE(`subscriberId`,`billingPeriod`);--> statement-breakpoint
ALTER TABLE `meterReadings` ADD CONSTRAINT `meterReadings_subscriberId_subscribers_id_fk` FOREIGN KEY (`subscriberId`) REFERENCES `subscribers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `readings_subscriber_date_idx` ON `meterReadings` (`subscriberId`,`readingAt`);--> statement-breakpoint
ALTER TABLE `invoices` DROP COLUMN `meterId`;--> statement-breakpoint
ALTER TABLE `meterReadings` DROP COLUMN `meterId`;
