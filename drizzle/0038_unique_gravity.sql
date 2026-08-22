ALTER TABLE `tenantMessagingConfigurations` ADD `autoSendAfterApproval` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tenantMessagingConfigurations` ADD `autoSendCron` varchar(40);--> statement-breakpoint
ALTER TABLE `tenantMessagingConfigurations` ADD `scheduleCronTaskUid` varchar(65);--> statement-breakpoint
CREATE INDEX `tenant_messaging_schedule_task_idx` ON `tenantMessagingConfigurations` (`scheduleCronTaskUid`);