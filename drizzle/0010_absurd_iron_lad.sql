CREATE TABLE `platformSecurityEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventType` enum('suspicious_login','backup','security_change') NOT NULL,
	`severity` enum('info','warning','critical') NOT NULL DEFAULT 'info',
	`status` enum('open','resolved','success','failed') NOT NULL DEFAULT 'open',
	`title` varchar(180) NOT NULL,
	`details` text,
	`metadata` json,
	`relatedUserId` int,
	`createdByUserId` int,
	`resolvedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformSecurityEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `platformSecuritySettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`settingKey` varchar(100) NOT NULL,
	`isEnabled` boolean NOT NULL DEFAULT false,
	`value` text,
	`updatedByUserId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformSecuritySettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_security_setting_key_unique` UNIQUE(`settingKey`)
);
--> statement-breakpoint
ALTER TABLE `generators` MODIFY COLUMN `status` enum('active','maintenance','stopped','offline','blocked') NOT NULL DEFAULT 'stopped';--> statement-breakpoint
ALTER TABLE `platformSecurityEvents` ADD CONSTRAINT `platformSecurityEvents_relatedUserId_users_id_fk` FOREIGN KEY (`relatedUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platformSecurityEvents` ADD CONSTRAINT `platformSecurityEvents_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `platformSecuritySettings` ADD CONSTRAINT `platformSecuritySettings_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `platform_security_event_type_date_idx` ON `platformSecurityEvents` (`eventType`,`createdAt`);--> statement-breakpoint
CREATE INDEX `platform_security_event_status_idx` ON `platformSecurityEvents` (`status`,`severity`);