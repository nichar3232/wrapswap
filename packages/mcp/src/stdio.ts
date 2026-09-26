#!/usr/bin/env -S npx tsx
// stdio entry point for local MCP clients (Claude Desktop, Claude Code, Cursor). Env: UNISON_API_URL (default: public funnel).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createUnisonServer } from "./server.js";
import { toolsFor } from "./registry.js";

const server = createUnisonServer(undefined, toolsFor());
await server.connect(new StdioServerTransport());
