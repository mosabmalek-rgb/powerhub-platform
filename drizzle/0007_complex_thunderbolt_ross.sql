ALTER TABLE `meterReadings` ADD `clientOperationId` varchar(80);--> statement-breakpoint
ALTER TABLE `meterReadings` ADD CONSTRAINT `meterReadings_clientOperationId_unique` UNIQUE(`clientOperationId`);
