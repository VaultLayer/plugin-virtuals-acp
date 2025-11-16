import { Plugin } from "@elizaos/core";
import { AcpService } from "./service";

const virtualsAcpPlugin: Plugin = {
    name: "plugin-virtuals-acp",
    description: "Virtuals ACP (Agent Communication Protocol) service plugin for ElizaOS.",
    services: [AcpService],
    routes: [],
};

export default virtualsAcpPlugin;
export { AcpService } from "./service";
export * from "./types";
export * from "./helper";
// Generic Eliza handler for general queries (can be used by any agent)
export * from "./handlers/elizaHandler";