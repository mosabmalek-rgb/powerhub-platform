CREATE TABLE `tenantInvoiceMessageTemplates` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`channel` enum('whatsapp','sms') NOT NULL,
	`eventType` enum('invoice_issued') NOT NULL DEFAULT 'invoice_issued',
	`body` text NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenantInvoiceMessageTemplates_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_invoice_template_unique` UNIQUE(`tenantId`,`channel`,`eventType`)
);
--> statement-breakpoint
ALTER TABLE `tenantInvoiceMessageTemplates` ADD CONSTRAINT `tenantInvoiceMessageTemplates_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;