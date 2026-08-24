CREATE TABLE `userQuickActionPreferences` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`siteId` int NOT NULL,
	`actionIds` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `userQuickActionPreferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_quick_actions_user_site_unique` UNIQUE(`userId`,`siteId`)
);
--> statement-breakpoint
ALTER TABLE `userQuickActionPreferences` ADD CONSTRAINT `userQuickActionPreferences_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `userQuickActionPreferences` ADD CONSTRAINT `userQuickActionPreferences_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `user_quick_actions_site_idx` ON `userQuickActionPreferences` (`siteId`);