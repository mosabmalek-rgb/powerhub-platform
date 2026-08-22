ALTER TABLE `payments` ADD `transferFromAccount` varchar(30);--> statement-breakpoint
ALTER TABLE `payments` ADD `transferFromType` enum('jawwal_pay','palpay','bank_of_palestine');--> statement-breakpoint
ALTER TABLE `payments` ADD `transferToAccount` varchar(30);--> statement-breakpoint
ALTER TABLE `payments` ADD `transferToType` enum('jawwal_pay','palpay','bank_of_palestine');