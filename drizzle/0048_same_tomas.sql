CREATE TABLE `tenantTweetSmsAccounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`apiEndpoint` varchar(500),
	`credentialCiphertext` text,
	`credentialIv` varchar(64),
	`credentialKeyVersion` int NOT NULL DEFAULT 1,
	`senderName` varchar(120),
	`monthlyLimit` int NOT NULL DEFAULT 0,
	`isActive` boolean NOT NULL DEFAULT false,
	`lastTestedAt` timestamp,
	`lastError` text,
	`createdByUserId` int,
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tenantTweetSmsAccounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `tenant_tweetsms_account_unique` UNIQUE(`tenantId`)
);
--> statement-breakpoint
ALTER TABLE `tenantTweetSmsAccounts` ADD CONSTRAINT `tenantTweetSmsAccounts_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenantTweetSmsAccounts` ADD CONSTRAINT `tenantTweetSmsAccounts_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tenantTweetSmsAccounts` ADD CONSTRAINT `tenantTweetSmsAccounts_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `tenant_tweetsms_account_active_idx` ON `tenantTweetSmsAccounts` (`isActive`);