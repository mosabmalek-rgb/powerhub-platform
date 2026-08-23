CREATE TABLE `platformTweetSmsAccounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`apiEndpoint` varchar(500) NOT NULL,
	`credentialCiphertext` text NOT NULL,
	`credentialIv` varchar(64) NOT NULL,
	`credentialKeyVersion` int NOT NULL DEFAULT 1,
	`senderName` varchar(120),
	`lowBalanceThreshold` int NOT NULL DEFAULT 100,
	`lastProviderBalance` int,
	`lastBalanceCheckedAt` timestamp,
	`lastTestedAt` timestamp,
	`lastError` text,
	`isActive` boolean NOT NULL DEFAULT false,
	`createdByUserId` int,
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformTweetSmsAccounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `platformTweetSmsBalanceAlerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`accountId` int NOT NULL,
	`balance` int NOT NULL,
	`threshold` int NOT NULL,
	`status` enum('open','resolved') NOT NULL DEFAULT 'open',
	`notifiedAt` timestamp NOT NULL DEFAULT (now()),
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformTweetSmsBalanceAlerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `platformTweetSmsAccounts` ADD CONSTRAINT `platformTweetSmsAccounts_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platformTweetSmsAccounts` ADD CONSTRAINT `platformTweetSmsAccounts_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platformTweetSmsBalanceAlerts` ADD CONSTRAINT `platform_tweetsms_alert_account_fk` FOREIGN KEY (`accountId`) REFERENCES `platformTweetSmsAccounts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `platform_tweetsms_account_active_idx` ON `platformTweetSmsAccounts` (`isActive`);--> statement-breakpoint
CREATE INDEX `platform_tweetsms_alert_account_status_idx` ON `platformTweetSmsBalanceAlerts` (`accountId`,`status`);
