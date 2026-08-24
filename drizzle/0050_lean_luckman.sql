CREATE TABLE `platformSmsFallbackProviders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`providerKey` varchar(80) NOT NULL,
	`apiEndpoint` varchar(500),
	`credentialCiphertext` text,
	`credentialIv` varchar(64),
	`credentialKeyVersion` int NOT NULL DEFAULT 1,
	`senderName` varchar(120),
	`priority` int NOT NULL DEFAULT 100,
	`integrationStatus` enum('pending_contract','ready') NOT NULL DEFAULT 'pending_contract',
	`isActive` boolean NOT NULL DEFAULT false,
	`lastTestedAt` timestamp,
	`lastError` text,
	`createdByUserId` int,
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformSmsFallbackProviders_id` PRIMARY KEY(`id`),
	CONSTRAINT `platformSmsFallbackProviders_providerKey_unique` UNIQUE(`providerKey`)
);
--> statement-breakpoint
ALTER TABLE `platformSmsFallbackProviders` ADD CONSTRAINT `platformSmsFallbackProviders_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platformSmsFallbackProviders` ADD CONSTRAINT `platformSmsFallbackProviders_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `platform_sms_fallback_active_priority_idx` ON `platformSmsFallbackProviders` (`isActive`,`priority`);