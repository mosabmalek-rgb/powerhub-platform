ALTER TABLE `subscribers` ADD `clientOperationId` varchar(80);--> statement-breakpoint
ALTER TABLE `subscribers` ADD CONSTRAINT `subscriber_client_operation_unique` UNIQUE(`clientOperationId`);