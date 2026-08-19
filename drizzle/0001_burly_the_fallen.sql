CREATE TABLE `auditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int,
	`entityType` varchar(80) NOT NULL,
	`entityId` varchar(80) NOT NULL,
	`action` varchar(80) NOT NULL,
	`beforeData` json,
	`afterData` json,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`generatorId` int,
	`category` enum('fuel','maintenance','payroll','parts','transport','other') NOT NULL,
	`description` varchar(255) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`occurredAt` timestamp NOT NULL DEFAULT (now()),
	`referenceNo` varchar(120),
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `generators` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`code` varchar(50) NOT NULL,
	`name` varchar(160) NOT NULL,
	`serialNumber` varchar(100),
	`ratedCapacityKw` decimal(12,3) NOT NULL,
	`fuelType` enum('diesel','gasoline','gas','other') NOT NULL DEFAULT 'diesel',
	`fuelLevelLiters` decimal(12,2) NOT NULL DEFAULT '0',
	`operatingHours` decimal(12,2) NOT NULL DEFAULT '0',
	`status` enum('active','maintenance','stopped','offline') NOT NULL DEFAULT 'stopped',
	`lastMaintenanceAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `generators_id` PRIMARY KEY(`id`),
	CONSTRAINT `generator_site_code_unique` UNIQUE(`siteId`,`code`)
);
--> statement-breakpoint
CREATE TABLE `invoiceShareLinks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int NOT NULL,
	`tokenHash` varchar(128) NOT NULL,
	`tokenPreview` varchar(20) NOT NULL,
	`expiresAt` timestamp,
	`revokedAt` timestamp,
	`viewCount` int NOT NULL DEFAULT 0,
	`lastViewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `invoiceShareLinks_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoiceShareLinks_tokenHash_unique` UNIQUE(`tokenHash`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`subscriberId` int NOT NULL,
	`meterId` int NOT NULL,
	`readingId` int,
	`tariffId` int,
	`invoiceNo` varchar(60) NOT NULL,
	`billingPeriod` varchar(7) NOT NULL,
	`issueDate` timestamp NOT NULL DEFAULT (now()),
	`dueDate` timestamp NOT NULL,
	`previousReading` decimal(15,3),
	`currentReading` decimal(15,3),
	`consumptionKwh` decimal(15,3) NOT NULL DEFAULT '0',
	`pricePerKwh` decimal(14,4) NOT NULL DEFAULT '0',
	`fixedFee` decimal(14,2) NOT NULL DEFAULT '0',
	`taxAmount` decimal(14,2) NOT NULL DEFAULT '0',
	`discountAmount` decimal(14,2) NOT NULL DEFAULT '0',
	`totalAmount` decimal(14,2) NOT NULL DEFAULT '0',
	`paidAmount` decimal(14,2) NOT NULL DEFAULT '0',
	`balanceDue` decimal(14,2) NOT NULL DEFAULT '0',
	`status` enum('draft','issued','partially_paid','paid','overdue','cancelled') NOT NULL DEFAULT 'draft',
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoices_invoiceNo_unique` UNIQUE(`invoiceNo`),
	CONSTRAINT `invoice_meter_period_unique` UNIQUE(`meterId`,`billingPeriod`)
);
--> statement-breakpoint
CREATE TABLE `meterReadings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`meterId` int NOT NULL,
	`readingAt` timestamp NOT NULL DEFAULT (now()),
	`readingValue` decimal(15,3) NOT NULL,
	`previousReadingValue` decimal(15,3),
	`consumptionKwh` decimal(15,3),
	`captureMethod` enum('manual','photo','smart_meter') NOT NULL DEFAULT 'manual',
	`imageKey` varchar(500),
	`imageHash` varchar(128),
	`status` enum('draft','pending_review','approved','rejected') NOT NULL DEFAULT 'pending_review',
	`enteredByUserId` int,
	`reviewedByUserId` int,
	`reviewedAt` timestamp,
	`notes` text,
	`versionNo` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `meterReadings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `meters` (
	`id` int AUTO_INCREMENT NOT NULL,
	`subscriberId` int NOT NULL,
	`generatorId` int,
	`serialNumber` varchar(100) NOT NULL,
	`meterType` enum('manual','digital','smart') NOT NULL DEFAULT 'manual',
	`multiplier` decimal(8,3) NOT NULL DEFAULT '1',
	`installedAt` timestamp NOT NULL DEFAULT (now()),
	`status` enum('active','replaced','damaged','offline') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `meters_id` PRIMARY KEY(`id`),
	CONSTRAINT `meters_serialNumber_unique` UNIQUE(`serialNumber`)
);
--> statement-breakpoint
CREATE TABLE `notificationMessages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoiceId` int,
	`subscriberId` int,
	`channel` enum('whatsapp','sms') NOT NULL,
	`eventType` enum('invoice_issued','payment_reminder','payment_received','service_alert') NOT NULL,
	`recipient` varchar(50) NOT NULL,
	`status` enum('pending','submitted','delivered','read','failed') NOT NULL DEFAULT 'pending',
	`providerMessageId` varchar(200),
	`payload` json,
	`attempts` int NOT NULL DEFAULT 0,
	`lastError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notificationMessages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`subscriberId` int NOT NULL,
	`invoiceId` int,
	`paymentNo` varchar(60) NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`paymentMethod` enum('cash','wallet','bank_transfer','card') NOT NULL DEFAULT 'cash',
	`referenceNo` varchar(120),
	`status` enum('pending','completed','cancelled','refunded') NOT NULL DEFAULT 'completed',
	`collectedByUserId` int,
	`paidAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_paymentNo_unique` UNIQUE(`paymentNo`)
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(160) NOT NULL,
	`code` varchar(50) NOT NULL,
	`city` varchar(100),
	`address` text,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sites_id` PRIMARY KEY(`id`),
	CONSTRAINT `sites_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `staffProfiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`siteId` int,
	`role` enum('owner','manager','accountant','collector','technician','viewer') NOT NULL,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `staffProfiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `staff_user_site_role_unique` UNIQUE(`userId`,`siteId`,`role`)
);
--> statement-breakpoint
CREATE TABLE `subscribers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`subscriberNo` varchar(50) NOT NULL,
	`fullName` varchar(180) NOT NULL,
	`phone` varchar(30) NOT NULL,
	`address` text,
	`subscriptionType` enum('residential','commercial') NOT NULL DEFAULT 'residential',
	`serviceStatus` enum('active','suspended','disconnected') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `subscribers_id` PRIMARY KEY(`id`),
	CONSTRAINT `subscriber_site_number_unique` UNIQUE(`siteId`,`subscriberNo`)
);
--> statement-breakpoint
CREATE TABLE `tariffs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`name` varchar(160) NOT NULL,
	`code` varchar(50) NOT NULL,
	`pricePerKwh` decimal(14,4) NOT NULL,
	`fixedFee` decimal(14,2) NOT NULL DEFAULT '0',
	`taxRate` decimal(7,4) NOT NULL DEFAULT '0',
	`isActive` boolean NOT NULL DEFAULT true,
	`effectiveFrom` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tariffs_id` PRIMARY KEY(`id`),
	CONSTRAINT `tariff_site_code_unique` UNIQUE(`siteId`,`code`)
);
--> statement-breakpoint
ALTER TABLE `auditLogs` ADD CONSTRAINT `auditLogs_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_generatorId_generators_id_fk` FOREIGN KEY (`generatorId`) REFERENCES `generators`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `generators` ADD CONSTRAINT `generators_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoiceShareLinks` ADD CONSTRAINT `invoiceShareLinks_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_subscriberId_subscribers_id_fk` FOREIGN KEY (`subscriberId`) REFERENCES `subscribers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_meterId_meters_id_fk` FOREIGN KEY (`meterId`) REFERENCES `meters`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_readingId_meterReadings_id_fk` FOREIGN KEY (`readingId`) REFERENCES `meterReadings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_tariffId_tariffs_id_fk` FOREIGN KEY (`tariffId`) REFERENCES `tariffs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meterReadings` ADD CONSTRAINT `meterReadings_meterId_meters_id_fk` FOREIGN KEY (`meterId`) REFERENCES `meters`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meterReadings` ADD CONSTRAINT `meterReadings_enteredByUserId_users_id_fk` FOREIGN KEY (`enteredByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meterReadings` ADD CONSTRAINT `meterReadings_reviewedByUserId_users_id_fk` FOREIGN KEY (`reviewedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meters` ADD CONSTRAINT `meters_subscriberId_subscribers_id_fk` FOREIGN KEY (`subscriberId`) REFERENCES `subscribers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `meters` ADD CONSTRAINT `meters_generatorId_generators_id_fk` FOREIGN KEY (`generatorId`) REFERENCES `generators`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notificationMessages` ADD CONSTRAINT `notificationMessages_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notificationMessages` ADD CONSTRAINT `notificationMessages_subscriberId_subscribers_id_fk` FOREIGN KEY (`subscriberId`) REFERENCES `subscribers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_subscriberId_subscribers_id_fk` FOREIGN KEY (`subscriberId`) REFERENCES `subscribers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_collectedByUserId_users_id_fk` FOREIGN KEY (`collectedByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staffProfiles` ADD CONSTRAINT `staffProfiles_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `staffProfiles` ADD CONSTRAINT `staffProfiles_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscribers` ADD CONSTRAINT `subscribers_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tariffs` ADD CONSTRAINT `tariffs_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `auditLogs` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `audit_user_date_idx` ON `auditLogs` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `expenses_site_date_idx` ON `expenses` (`siteId`,`occurredAt`);--> statement-breakpoint
CREATE INDEX `generators_site_status_idx` ON `generators` (`siteId`,`status`);--> statement-breakpoint
CREATE INDEX `invoices_site_status_idx` ON `invoices` (`siteId`,`status`);--> statement-breakpoint
CREATE INDEX `readings_meter_date_idx` ON `meterReadings` (`meterId`,`readingAt`);--> statement-breakpoint
CREATE INDEX `readings_status_idx` ON `meterReadings` (`status`);--> statement-breakpoint
CREATE INDEX `payments_site_date_idx` ON `payments` (`siteId`,`paidAt`);--> statement-breakpoint
CREATE INDEX `subscribers_site_status_idx` ON `subscribers` (`siteId`,`serviceStatus`);