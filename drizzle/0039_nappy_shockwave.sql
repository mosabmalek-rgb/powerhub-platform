CREATE TABLE `messagingScheduleRuns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`configurationId` int NOT NULL,
	`taskUid` varchar(65),
	`status` enum('success','failed') NOT NULL DEFAULT 'success',
	`scanned` int NOT NULL DEFAULT 0,
	`submitted` int NOT NULL DEFAULT 0,
	`failed` int NOT NULL DEFAULT 0,
	`skipped` int NOT NULL DEFAULT 0,
	`error` text,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	CONSTRAINT `messagingScheduleRuns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `messagingScheduleRuns` ADD CONSTRAINT `messagingScheduleRuns_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messagingScheduleRuns` ADD CONSTRAINT `messagingScheduleRuns_configurationId_tenantMessagingConfigurations_id_fk` FOREIGN KEY (`configurationId`) REFERENCES `tenantMessagingConfigurations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `messaging_schedule_runs_tenant_date_idx` ON `messagingScheduleRuns` (`tenantId`,`startedAt`);--> statement-breakpoint
CREATE INDEX `messaging_schedule_runs_config_date_idx` ON `messagingScheduleRuns` (`configurationId`,`startedAt`);