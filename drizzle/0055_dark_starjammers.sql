ALTER TABLE `offlineSyncOperations` MODIFY COLUMN `operationType` enum('subscriber_create','subscriber_update','invoice_issue','payment_create') NOT NULL;--> statement-breakpoint
ALTER TABLE `payments` ADD `clientOperationId` varchar(80);--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payment_client_operation_unique` UNIQUE(`clientOperationId`);