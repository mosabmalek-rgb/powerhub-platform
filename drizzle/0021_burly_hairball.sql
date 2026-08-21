ALTER TABLE `payments` MODIFY COLUMN `paymentMethod` enum('cash','jawwal_pay','palpay','bank_of_palestine','wallet','bank_transfer','card') NOT NULL DEFAULT 'cash';--> statement-breakpoint
ALTER TABLE `payments` ADD `receiptImageKey` varchar(500);--> statement-breakpoint
ALTER TABLE `payments` ADD `receiptImageHash` varchar(64);