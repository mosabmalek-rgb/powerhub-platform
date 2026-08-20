ALTER TABLE `tenantOwnerProfiles` ADD `identityNumberCiphertext` text;--> statement-breakpoint
ALTER TABLE `tenantOwnerProfiles` ADD `identityNumberCiphertext` text;--> statement-breakpoint
ALTER TABLE `tenantOwnerProfiles` ADD `identityNumberIv` varchar(64);--> statement-breakpoint
ALTER TABLE `tenantOwnerProfiles` ADD `identityNumberLast4` varchar(4);--> statement-breakpoint
ALTER TABLE `users` ADD `mustChangePassword` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `temporaryPasswordIssuedAt` timestamp;
