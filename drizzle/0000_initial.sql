CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`details` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `audit_user_created_idx` ON `audit_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `bot_conversations` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_expiry_idx` ON `bot_conversations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "categories_not_self" CHECK("categories"."parent_id" is null or "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `chat_locks` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_locks_expiry_idx` ON `chat_locks` (`expires_at`);--> statement-breakpoint
CREATE TABLE `inventory_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`change_type` text NOT NULL,
	`quantity_change` integer NOT NULL,
	`previous_stock` integer NOT NULL,
	`new_stock` integer NOT NULL,
	`reference_id` text,
	`user_id` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reference_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "inventory_type_check" CHECK("inventory_logs"."change_type" in ('in','out','adjustment')),
	CONSTRAINT "inventory_balance_check" CHECK("inventory_logs"."new_stock" = "inventory_logs"."previous_stock" + "inventory_logs"."quantity_change" and "inventory_logs"."previous_stock" between 0 and 1000000 and "inventory_logs"."new_stock" between 0 and 1000000),
	CONSTRAINT "inventory_sign_check" CHECK(("inventory_logs"."change_type" = 'in' and "inventory_logs"."quantity_change" > 0) or ("inventory_logs"."change_type" = 'out' and "inventory_logs"."quantity_change" < 0) or "inventory_logs"."change_type" = 'adjustment')
);
--> statement-breakpoint
CREATE INDEX `inventory_product_created_idx` ON `inventory_logs` (`product_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inventory_created_idx` ON `inventory_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `inventory_reference_idx` ON `inventory_logs` (`reference_id`);--> statement-breakpoint
CREATE INDEX `inventory_user_idx` ON `inventory_logs` (`user_id`);--> statement-breakpoint
CREATE TABLE `mutation_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`result` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`product_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price` integer NOT NULL,
	`total_price` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "order_items_amount_check" CHECK("order_items"."quantity" between 1 and 1000000 and "order_items"."unit_price" >= 0 and "order_items"."total_price" = "order_items"."quantity" * "order_items"."unit_price" and "order_items"."total_price" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_items_order_product_idx` ON `order_items` (`order_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `order_items_product_idx` ON `order_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`order_number` text NOT NULL,
	`customer_telegram_id` integer NOT NULL,
	`customer_name` text NOT NULL,
	`customer_phone` text NOT NULL,
	`shipping_address` text NOT NULL,
	`total_amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_telegram_id`) REFERENCES `users`(`telegram_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "orders_status_check" CHECK("orders"."status" in ('pending','confirmed','processing','shipped','delivered','cancelled')),
	CONSTRAINT "orders_payment_check" CHECK("orders"."payment_status" in ('unpaid','paid','refunded')),
	CONSTRAINT "orders_total_check" CHECK("orders"."total_amount" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_telegram_id`);--> statement-breakpoint
CREATE INDEX `orders_status_created_idx` ON `orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_payment_created_idx` ON `orders` (`payment_status`,`created_at`);--> statement-breakpoint
CREATE TABLE `processed_updates` (
	`update_id` integer PRIMARY KEY NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `processed_updates_created_idx` ON `processed_updates` (`processed_at`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sku` text NOT NULL,
	`description` text,
	`price` integer NOT NULL,
	`cost_price` integer DEFAULT 0 NOT NULL,
	`stock_quantity` integer DEFAULT 0 NOT NULL,
	`min_stock_level` integer DEFAULT 5 NOT NULL,
	`category_id` text,
	`image_url` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "products_price_check" CHECK("products"."price" between 0 and 1000000000000 and "products"."cost_price" between 0 and 1000000000000),
	CONSTRAINT "products_stock_check" CHECK("products"."stock_quantity" between 0 and 1000000 and "products"."min_stock_level" between 0 and 1000000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku_unique` ON `products` (`sku`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`);--> statement-breakpoint
CREATE INDEX `products_active_stock_idx` ON `products` (`is_active`,`stock_quantity`);--> statement-breakpoint
CREATE INDEX `products_active_name_idx` ON `products` (`is_active`,`name`);--> statement-breakpoint
CREATE TABLE `store_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`telegram_id` integer NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text,
	`username` text,
	`role` text DEFAULT 'viewer' NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" in ('super_admin','admin','operator','viewer')),
	CONSTRAINT "users_telegram_check" CHECK("users"."telegram_id" > 0 and "users"."telegram_id" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_telegram_id_unique` ON `users` (`telegram_id`);--> statement-breakpoint
CREATE INDEX `users_role_active_idx` ON `users` (`role`,`is_active`);