CREATE TABLE `order_references` (
	`order_id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_reference_code_check" CHECK(length("order_references"."code") = 16 and substr("order_references"."code", 1, 4) = 'REF-' and substr("order_references"."code", 5) not glob '*[^A-Z0-9]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_references_code_unique` ON `order_references` (`code`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`carrier` text NOT NULL,
	`carrier_name` text DEFAULT '' NOT NULL,
	`tracking_number` text,
	`tracking_url` text,
	`postal_code` text,
	`shipping_cost` integer DEFAULT 0 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`dispatched_at` integer,
	`delivered_at` integer,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "shipments_carrier_check" CHECK("shipments"."carrier" in ('iran_post','tipax','chapar','courier','pickup','other')),
	CONSTRAINT "shipments_tracking_check" CHECK("shipments"."tracking_number" is null or length("shipments"."tracking_number") between 4 and 64),
	CONSTRAINT "shipments_required_tracking_check" CHECK("shipments"."carrier" in ('courier','pickup') or "shipments"."tracking_number" is not null),
	CONSTRAINT "shipments_carrier_name_check" CHECK(("shipments"."carrier" = 'other' and length("shipments"."carrier_name") between 2 and 60) or ("shipments"."carrier" <> 'other' and "shipments"."carrier_name" = '')),
	CONSTRAINT "shipments_cost_version_check" CHECK("shipments"."shipping_cost" between 0 and 1000000000000 and "shipments"."version" > 0),
	CONSTRAINT "shipments_postal_check" CHECK("shipments"."postal_code" is null or (length("shipments"."postal_code") = 10 and "shipments"."postal_code" not glob '*[^0-9]*')),
	CONSTRAINT "shipments_dates_check" CHECK("shipments"."delivered_at" is null or "shipments"."dispatched_at" is null or "shipments"."delivered_at" >= "shipments"."dispatched_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_order_id_unique` ON `shipments` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_carrier_tracking_idx` ON `shipments` (`carrier`,`carrier_name`,`tracking_number`);--> statement-breakpoint
CREATE INDEX `shipments_dispatched_idx` ON `shipments` (`dispatched_at`);--> statement-breakpoint
CREATE INDEX `shipments_created_by_idx` ON `shipments` (`created_by`);--> statement-breakpoint
CREATE INDEX `shipments_updated_by_idx` ON `shipments` (`updated_by`);--> statement-breakpoint
-- Additive upgrade: keep order IDs/numbers/items/logs untouched. A deterministic
-- ordinal supplies unique short references without random backfill collisions.
INSERT INTO `order_references` (`order_id`, `code`, `created_at`)
SELECT `id`, 'REF-' || printf('%012X', row_number() OVER (ORDER BY `id`)), `created_at`
FROM `orders`;
