import type { LinkType } from "./types";
import links from "./config/links.json";

/** @TODO maybe send this data to client for the customization model to show the data dynamically */
// This should be our single source of truth for link types and their properties
export const LINKS: Record<LinkType, any> = links;

// Static top-level route segments registered in router.ts. A "custom" code or
// a username occupying these would collide with a real route.
export const RESERVED_ROUTE_SEGMENTS: string[] = links.custom.reservedWords;
