CREATE TABLE `mobileApiSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tenantId` int NOT NULL,
	`refreshTokenHash` varchar(128) NOT NULL,
	`deviceLabel` varchar(160),
	`expiresAt` timestamp NOT NULL,
	`revokedAt` timestamp,
	`lastUsedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mobileApiSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `mobileApiSessions_refreshTokenHash_unique` UNIQUE(`refreshTokenHash`)
);
--> statement-breakpoint
ALTER TABLE `mobileApiSessions` ADD CONSTRAINT `mobileApiSessions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mobileApiSessions` ADD CONSTRAINT `mobileApiSessions_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mobile_api_sessions_user_tenant_idx` ON `mobileApiSessions` (`userId`,`tenantId`,`revokedAt`);--> statement-breakpoint
CREATE INDEX `mobile_api_sessions_expiry_idx` ON `mobileApiSessions` (`expiresAt`);