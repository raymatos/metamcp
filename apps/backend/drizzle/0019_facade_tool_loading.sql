CREATE TYPE "public"."tool_exposure_mode" AS ENUM('DIRECT', 'FACADE', 'HIDDEN');--> statement-breakpoint
DROP INDEX "namespace_tool_mappings_status_idx";--> statement-breakpoint
ALTER TABLE "namespace_tool_mappings" ADD COLUMN "exposure_mode" "tool_exposure_mode" DEFAULT 'DIRECT' NOT NULL;--> statement-breakpoint
UPDATE "namespace_tool_mappings" SET "exposure_mode" = 'HIDDEN' WHERE "status" = 'INACTIVE';--> statement-breakpoint
ALTER TABLE "namespaces" ADD COLUMN "facade_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "namespace_tool_mappings_exposure_mode_idx" ON "namespace_tool_mappings" USING btree ("exposure_mode");--> statement-breakpoint
ALTER TABLE "namespace_tool_mappings" DROP COLUMN "status";
