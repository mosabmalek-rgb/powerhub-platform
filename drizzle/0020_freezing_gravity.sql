CREATE TABLE `tenantPaymentReceiptMessageTemplates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`channel` enum('sms') NOT NULL DEFAULT 'sms',
	`body` text NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenantPaymentReceiptMessageTemplates_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_payment_receipt_template_unique` UNIQUE(`tenantId`,`channel`)
);
--> statement-breakpoint
ALTER TABLE `tenantPaymentReceiptMessageTemplates` ADD CONSTRAINT `tenantPaymentReceiptMessageTemplates_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;