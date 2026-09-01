import {
  NamespaceServerStatusUpdate,
  NamespaceToolOverridesUpdate,
  NamespaceToolStatusUpdate,
} from "@repo/zod-types";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../index";
import {
  namespaceServerMappingsTable,
  namespacesTable,
  namespaceToolMappingsTable,
} from "../schema";

type ExposureMode = "DIRECT" | "FACADE" | "HIDDEN";

export function resolveActiveExposureMode(
  currentMode: ExposureMode,
  facadeEnabled: boolean,
): Exclude<ExposureMode, "HIDDEN"> {
  if (currentMode !== "HIDDEN") return currentMode;
  return facadeEnabled ? "FACADE" : "DIRECT";
}

export class NamespaceMappingsRepository {
  async updateServerStatus(input: NamespaceServerStatusUpdate) {
    const [updatedMapping] = await db
      .update(namespaceServerMappingsTable)
      .set({
        status: input.status,
      })
      .where(
        and(
          eq(namespaceServerMappingsTable.namespace_uuid, input.namespaceUuid),
          eq(namespaceServerMappingsTable.mcp_server_uuid, input.serverUuid),
        ),
      )
      .returning();

    return updatedMapping;
  }

  async updateToolStatus(input: NamespaceToolStatusUpdate) {
    let exposureMode: ExposureMode = "HIDDEN";
    if (input.status === "ACTIVE") {
      const [current] = await db
        .select({
          exposureMode: namespaceToolMappingsTable.exposure_mode,
          facadeEnabled: namespacesTable.facade_enabled,
        })
        .from(namespaceToolMappingsTable)
        .innerJoin(
          namespacesTable,
          eq(namespacesTable.uuid, namespaceToolMappingsTable.namespace_uuid),
        )
        .where(
          and(
            eq(namespaceToolMappingsTable.namespace_uuid, input.namespaceUuid),
            eq(namespaceToolMappingsTable.tool_uuid, input.toolUuid),
            eq(namespaceToolMappingsTable.mcp_server_uuid, input.serverUuid),
          ),
        );

      if (!current) return undefined;
      exposureMode = resolveActiveExposureMode(
        current.exposureMode,
        current.facadeEnabled,
      );
    }

    const [updatedMapping] = await db
      .update(namespaceToolMappingsTable)
      .set({
        exposure_mode: exposureMode,
      })
      .where(
        and(
          eq(namespaceToolMappingsTable.namespace_uuid, input.namespaceUuid),
          eq(namespaceToolMappingsTable.tool_uuid, input.toolUuid),
          eq(namespaceToolMappingsTable.mcp_server_uuid, input.serverUuid),
        ),
      )
      .returning();

    return updatedMapping;
  }

  async updateToolOverrides(input: NamespaceToolOverridesUpdate) {
    const [updatedMapping] = await db
      .update(namespaceToolMappingsTable)
      .set({
        override_name: input.overrideName,
        override_title: input.overrideTitle,
        override_description: input.overrideDescription,
        override_annotations: input.overrideAnnotations,
      })
      .where(
        and(
          eq(namespaceToolMappingsTable.namespace_uuid, input.namespaceUuid),
          eq(namespaceToolMappingsTable.tool_uuid, input.toolUuid),
          eq(namespaceToolMappingsTable.mcp_server_uuid, input.serverUuid),
        ),
      )
      .returning();

    return updatedMapping;
  }

  async findServerMapping(namespaceUuid: string, serverUuid: string) {
    const [mapping] = await db
      .select()
      .from(namespaceServerMappingsTable)
      .where(
        and(
          eq(namespaceServerMappingsTable.namespace_uuid, namespaceUuid),
          eq(namespaceServerMappingsTable.mcp_server_uuid, serverUuid),
        ),
      );

    return mapping;
  }

  /**
   * Find all namespace UUIDs that use a specific MCP server
   */
  async findNamespacesByServerUuid(serverUuid: string): Promise<string[]> {
    const mappings = await db
      .select({
        namespace_uuid: namespaceServerMappingsTable.namespace_uuid,
      })
      .from(namespaceServerMappingsTable)
      .where(eq(namespaceServerMappingsTable.mcp_server_uuid, serverUuid));

    return mappings.map((mapping) => mapping.namespace_uuid);
  }

  /**
   * Get all existing tool mappings for a namespace
   */
  async findToolMappingsByNamespace(namespaceUuid: string) {
    const mappings = await db
      .select()
      .from(namespaceToolMappingsTable)
      .where(eq(namespaceToolMappingsTable.namespace_uuid, namespaceUuid));

    return mappings;
  }

  async findToolMapping(
    namespaceUuid: string,
    toolUuid: string,
    serverUuid: string,
  ) {
    const [mapping] = await db
      .select()
      .from(namespaceToolMappingsTable)
      .where(
        and(
          eq(namespaceToolMappingsTable.namespace_uuid, namespaceUuid),
          eq(namespaceToolMappingsTable.tool_uuid, toolUuid),
          eq(namespaceToolMappingsTable.mcp_server_uuid, serverUuid),
        ),
      );

    return mapping;
  }

  /**
   * Bulk upsert namespace tool mappings for a namespace
   * Used when refreshing tools from MetaMCP connection
   */
  async bulkUpsertNamespaceToolMappings(input: {
    namespaceUuid: string;
    toolMappings: Array<{
      toolUuid: string;
      serverUuid: string;
      status?: "ACTIVE" | "INACTIVE";
    }>;
  }) {
    if (!input.toolMappings || input.toolMappings.length === 0) {
      return [];
    }

    const [namespace] = await db
      .select({ facadeEnabled: namespacesTable.facade_enabled })
      .from(namespacesTable)
      .where(eq(namespacesTable.uuid, input.namespaceUuid));

    const mappingsToInsert = input.toolMappings.map((mapping) => ({
      namespace_uuid: input.namespaceUuid,
      tool_uuid: mapping.toolUuid,
      mcp_server_uuid: mapping.serverUuid,
      exposure_mode:
        mapping.status === "INACTIVE"
          ? ("HIDDEN" as const)
          : mapping.status === "ACTIVE"
            ? ("DIRECT" as const)
            : namespace?.facadeEnabled
              ? ("FACADE" as const)
              : ("DIRECT" as const),
    }));

    // Upsert the mappings - if they exist, update the status; if not, insert them
    return await db
      .insert(namespaceToolMappingsTable)
      .values(mappingsToInsert)
      .onConflictDoUpdate({
        target: [
          namespaceToolMappingsTable.namespace_uuid,
          namespaceToolMappingsTable.tool_uuid,
        ],
        set: {
          mcp_server_uuid: sql`excluded.mcp_server_uuid`,
        },
      })
      .returning();
  }
}

export const namespaceMappingsRepository = new NamespaceMappingsRepository();
