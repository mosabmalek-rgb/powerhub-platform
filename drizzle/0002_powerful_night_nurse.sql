CREATE TABLE `invoiceLines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int NOT NULL,
	`lineType` enum('energy','fixed_fee','tax','discount','late_fee','other') NOT NULL,
	`description` varchar(255) NOT NULL,
	`quantity` decimal(15,3) NOT NULL DEFAULT '1',
	`unitPrice` decimal(14,4) NOT NULL DEFAULT '0',
	`amount` decimal(14,2) NOT NULL,
	`displayOrder` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoiceLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `invoiceLines` ADD CONSTRAINT `invoiceLines_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice_idx` ON `invoiceLines` (`invoiceId`,`displayOrder`);