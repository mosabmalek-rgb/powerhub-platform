ALTER TABLE `generators` MODIFY COLUMN `status` enum('pending','active','maintenance','stopped','offline','blocked') NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE `generators` ADD CONSTRAINT `generator_name_unique` UNIQUE(`name`);--> statement-breakpoint
ALTER TABLE `tenantOwnerProfiles` ADD CONSTRAINT `tenant_owner_profile_phone_unique` UNIQUE(`phone`);