-- Forward-only, additive upgrade. Existing IDs, barcodes, timestamps, actors and
-- audit rows remain untouched; no table rebuild and no FK disabling is needed.
CREATE TABLE `shipment_sequences` (
  `order_id` text PRIMARY KEY NOT NULL,
  `last_number` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
  CONSTRAINT "shipment_sequence_check" CHECK(`last_number` between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE `shipments` ADD COLUMN `parcel_number` integer DEFAULT 1 NOT NULL
  CONSTRAINT "shipments_parcel_number_check" CHECK(`parcel_number` > 0);
--> statement-breakpoint
ALTER TABLE `shipments` ADD COLUMN `state` text DEFAULT 'draft' NOT NULL
  CONSTRAINT "shipments_state_check" CHECK(`state` in ('draft','dispatched','delivered'));
--> statement-breakpoint
UPDATE `shipments` SET `state` = CASE
  WHEN `delivered_at` IS NOT NULL OR (SELECT `status` FROM `orders` WHERE `orders`.`id` = `shipments`.`order_id`) = 'delivered' THEN 'delivered'
  WHEN `dispatched_at` IS NOT NULL OR (SELECT `status` FROM `orders` WHERE `orders`.`id` = `shipments`.`order_id`) = 'shipped' THEN 'dispatched'
  ELSE 'draft' END;
--> statement-breakpoint
INSERT INTO `shipment_sequences` (`order_id`, `last_number`)
SELECT `order_id`, max(`parcel_number`) FROM `shipments` GROUP BY `order_id`;
--> statement-breakpoint
DROP INDEX `shipments_order_id_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `shipments_order_parcel_idx` ON `shipments` (`order_id`,`parcel_number`);
--> statement-breakpoint
CREATE INDEX `shipments_order_state_idx` ON `shipments` (`order_id`,`state`);
