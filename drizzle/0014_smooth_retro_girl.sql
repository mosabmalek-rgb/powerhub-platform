CREATE TABLE `platformAccessInvitations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(320) NOT NULL,
	`platformRole` enum('platform_owner','platform_admin','finance_admin') NOT NULL,
	`tokenHash` varchar(128) NOT NULL,
	`status` enum('invited','accepted','revoked','expired') NOT NULL DEFAULT 'invited',
	`invitedByUserId` int NOT NULL,
	`acceptedByUserId` int,
	`expiresAt` timestamp NOT NULL,
	`acceptedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformAccessInvitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `platformAccessInvitations_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
ALTER TABLE `platformAccessInvitations` ADD CONSTRAINT `platformAccessInvitations_invitedByUserId_users_id_fk` FOREIGN KEY (`invitedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platformAccessInvitations` ADD CONSTRAINT `platformAccessInvitations_acceptedByUserId_users_id_fk` FOREIGN KEY (`acceptedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `platform_access_invitation_email_status_idx` ON `platformAccessInvitations` (`email`,`status`);