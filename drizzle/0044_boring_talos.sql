CREATE TABLE `employeeAttendance` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`employeeId` int NOT NULL,
	`siteId` int NOT NULL,
	`workDate` timestamp NOT NULL,
	`regularHours` decimal(5,2) NOT NULL DEFAULT '0',
	`overtimeHours` decimal(5,2) NOT NULL DEFAULT '0',
	`absentDays` decimal(4,2) NOT NULL DEFAULT '0',
	`notes` varchar(500),
	`createdByUserId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `employeeAttendance_id` PRIMARY KEY(`id`),
	CONSTRAINT `employee_attendance_employee_date_unique` UNIQUE(`employeeId`,`workDate`)
);
--> statement-breakpoint
ALTER TABLE `employeeAttendance` ADD CONSTRAINT `employeeAttendance_tenantId_tenants_id_fk` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employeeAttendance` ADD CONSTRAINT `employeeAttendance_employeeId_employees_id_fk` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employeeAttendance` ADD CONSTRAINT `employeeAttendance_siteId_sites_id_fk` FOREIGN KEY (`siteId`) REFERENCES `sites`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `employeeAttendance` ADD CONSTRAINT `employeeAttendance_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `employee_attendance_tenant_site_date_idx` ON `employeeAttendance` (`tenantId`,`siteId`,`workDate`);