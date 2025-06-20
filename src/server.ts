import { FastMCP } from "fastmcp";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { EventEmitter } from "events";
import { fileTypeFromBuffer } from "file-type";
import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { fetch } from "undici";
import { execa } from "execa";
import { join, dirname } from "path";
import {
  BaseRequest,
  BaseResponse,
  BuildCodeRequest,
  BuildTestsRequest,
  BuildDocsRequest,
  ChatRequest,
  ChatResponse,
  MCPServerConfig,
  MCPConfig,
  DisperslMCPError,
  UserError,
  MCPTool,
  MCPClient,
  AgenticSession,
  MCPClientConfig,
  GitOperationRequest,
  GenerateDocsRequest,
  Content,
  TextContent,
  ImageContent,
  AudioContent,
  ResourceContent,
  MCPToolCallRequest,
  MCPHttpConfig
} from "./types.js";
import { v4 as uuidv4 } from "uuid";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ZodType } from "zod";

const execAsync = async (command: string, args?: string[]) => {
  const { stdout, stderr } = await execa(command, args);
  return { stdout, stderr };
};

// API Configuration
const test = true;
const DISPERSL_API_BASE = test ? "http://localhost:3000" : "https://api.dispersl.com/v1";

// Type Definitions
interface ApiResponse {
  status: "success" | "error";
  content?: string | Content[];
  error?: string;
}

interface ToolCall {
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolResponse {
  status: "SUCCESS" | "FAILURE";
  message: string;
  tool: string;
  output: string;
}

// Multipart Response Processing
async function processMultipartResponse(
  response: any,
  options: {
    onTextContent?: (text: string) => void;
    onKnowledgeRetrieved?: (knowledge: string) => Promise<void>;
    onToolCall?: (toolData: Record<string, unknown>) => Promise<void>;
    onStreamUpdate?: (fullResponse: string) => void;
  }
): Promise<string> {
  let fullResponse = '';
  const { onTextContent, onKnowledgeRetrieved, onToolCall, onStreamUpdate } = options;

  if (response.type === 'text' && response.content) {
    fullResponse += response.content;
    onTextContent?.(response.content);
  } else if (response.type === 'knowledge' && response.knowledge) {
    await onKnowledgeRetrieved?.(response.knowledge);
  } else if (response.type === 'tool' && response.tool) {
    await onToolCall?.(response.tool);
  }

  onStreamUpdate?.(fullResponse);
  return fullResponse;
}

// Main Server Class
export class DisperslMCPServer {
  private server: FastMCP;
  private clients: Map<string, MCPClient>;
  private sessions: Map<string, AgenticSession>;
  private mcpConfig: MCPConfig | null = null;
  private mcpConfigPath: string;
  private tools: Map<string, MCPTool>;
  private apiKey?: string;

  constructor(apiKey?: string) {
    // Get API key from argument or environment variable
    this.apiKey = apiKey || process.env.DISPERSL_API_KEY;
    this.server = new FastMCP({
      name: "dispersl-mcp",
      version: "0.1.0",
      instructions: "I am an MCP server that can act as both a server and client. I can connect to other MCP servers and execute their tools in agentic loops.",
      health: {
        enabled: true,
        message: "ok",
        path: "/health",
        status: 200,
      },      
    });

    this.clients = new Map();
    this.sessions = new Map();
    this.mcpConfigPath = this.findMCPConfigPath();
    this.tools = new Map();

    this.setupTools();
    this.initializeMCPConnections();
  }

  private setupTools() {
    // Model Management
    const listModelsTool: MCPTool = {
      name: "list_models",
      description: "List available models",
      parameters: z.object({}),
      execute: async () => {
        const models = [
          {
            id: "meta-llama/llama-4-maverick:free",
            name: "Llama 4 Maverick",
            description: "A powerful language model for code generation and analysis",
            context_length: 8192,
            tier_requirements: { free_model: true }
          }
        ];
        return {
          type: "text",
          text: JSON.stringify({ status: "success", models })
        };
      }
    };
    this.server.addTool({
      name: listModelsTool.name,
      description: listModelsTool.description,
      parameters: listModelsTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await listModelsTool.execute(args);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(listModelsTool.name, listModelsTool);

    // Code Generation
    const buildCodeTool: MCPTool = {
      name: "build_code",
      description: "Generate code based on a prompt using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        conversation_id: z.string().optional(),
        knowledge: z.string().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as BuildCodeRequest;
        const sessionId = req.conversation_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        const session = this.sessions.get(sessionId)!;
        try {
          await this.executeDisperslAgent("/build/code", req, session);
          const tool = session.tools.get("build_code");
          const content = tool?.lastResponse?.content;
          return {
            type: "text",
            text: typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map(c => typeof c === "string" ? c : (c.type === "text" ? c.text : "")).join("")
                : "Code generation completed"
          };
        } catch (error) {
          return {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          };
        }
      }
    };
    this.server.addTool({
      name: buildCodeTool.name,
      description: buildCodeTool.description,
      parameters: buildCodeTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await buildCodeTool.execute(args as BuildCodeRequest);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(buildCodeTool.name, buildCodeTool);

    // Test Generation
    const buildTestsTool: MCPTool = {
      name: "build_tests",
      description: "Generate tests based on a prompt using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        conversation_id: z.string().optional(),
        knowledge: z.string().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as BuildTestsRequest;
        const sessionId = req.conversation_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        const session = this.sessions.get(sessionId)!;
        try {
          await this.executeDisperslAgent("/build/tests", req, session);
          const lastResponse = session.tools.get("build_tests")?.lastResponse;
          const content = lastResponse?.content;
          return {
            type: "text",
            text: typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map(c => typeof c === "string" ? c : (c.type === "text" ? c.text : "")).join("")
                : "Test generation completed"
          };
        } catch (error) {
          return {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          };
        }
      }
    };
    this.server.addTool({
      name: buildTestsTool.name,
      description: buildTestsTool.description,
      parameters: buildTestsTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await buildTestsTool.execute(args);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(buildTestsTool.name, buildTestsTool);

    // Git Operations
    const gitOperationTool: MCPTool = {
      name: "git_operation",
      description: "Execute Git operations based on a prompt using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        conversation_id: z.string().optional(),
        knowledge: z.string().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as GitOperationRequest;
        const sessionId = req.conversation_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        const session = this.sessions.get(sessionId)!;
        try {
          await this.executeDisperslAgent("/build/git", req, session);
          const lastResponse = session.tools.get("git_operation")?.lastResponse;
          const content = lastResponse?.content;
          return {
            type: "text",
            text: typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map(c => typeof c === "string" ? c : (c.type === "text" ? c.text : "")).join("")
                : "Git operation completed"
          };
        } catch (error) {
          return {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          };
        }
      }
    };
    this.server.addTool({
      name: gitOperationTool.name,
      description: gitOperationTool.description,
      parameters: gitOperationTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await gitOperationTool.execute(args);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(gitOperationTool.name, gitOperationTool);

    // Documentation Generation
    const generateDocsTool: MCPTool = {
      name: "generate_docs",
      description: "Generate documentation for a repository using agentic execution",
      parameters: z.object({
        url: z.string(),
        branch: z.string().optional(),
        team_access: z.boolean().optional(),
        model: z.string().optional(),
        context: z.string().optional(),
        conversation_id: z.string().optional(),
        knowledge: z.string().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as GenerateDocsRequest;
        const sessionId = req.conversation_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        const session = this.sessions.get(sessionId)!;
        try {
          await this.executeDisperslAgent("/docs/repo", req, session);
          const lastResponse = session.tools.get("generate_docs")?.lastResponse;
          const content = lastResponse?.content;
          return {
            type: "text",
            text: typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map(c => typeof c === "string" ? c : (c.type === "text" ? c.text : "")).join("")
                : "Documentation generation completed"
          };
        } catch (error) {
          return {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          };
        }
      }
    };
    this.server.addTool({
      name: generateDocsTool.name,
      description: generateDocsTool.description,
      parameters: generateDocsTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await generateDocsTool.execute(args);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(generateDocsTool.name, generateDocsTool);

    // Chat
    const chatTool: MCPTool = {
      name: "chat",
      description: "Chat with the agent using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        conversation_id: z.string().optional(),
        knowledge: z.string().optional(),
        memory: z.boolean().optional(),
        voice: z.boolean().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as ChatRequest;
        const sessionId = req.conversation_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        const session = this.sessions.get(sessionId)!;
        try {
          session.conversation_history.push({
            role: "user",
            content: req.prompt,
            timestamp: new Date().toISOString()
          });
          const stream = await this.executeDisperslStream("/chat", req, session);
          let fullResponse = '';
          for await (const chunk of stream) {
            fullResponse += chunk;
          }
          return {
            type: "text",
            text: fullResponse
          };
        } catch (error) {
          return {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
          };
        }
      }
    };
    this.server.addTool({
      name: chatTool.name,
      description: chatTool.description,
      parameters: chatTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await chatTool.execute(args);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(chatTool.name, chatTool);

    // Session Management
    const startSessionTool: MCPTool = {
      name: "start_session",
      description: "Start a new agentic session",
      parameters: z.object({
        session_id: z.string()
      }),
      execute: async (args: unknown) => {
        const req = args as { session_id: string };
        this.sessions.set(req.session_id, {
          id: req.session_id,
          tools: new Map(),
          context: {},
          conversation_history: [],
          active_tools: new Set()
        });
        return {
          type: "text",
          text: `Session ${req.session_id} started`
        };
      }
    };
    this.server.addTool({
      name: startSessionTool.name,
      description: startSessionTool.description,
      parameters: startSessionTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await startSessionTool.execute(args);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(startSessionTool.name, startSessionTool);

    this.server.addTool({
      name: "end_session",
      description: "End an active session",
      parameters: z.object({
        session_id: z.string()
      }),
      execute: async (args: { session_id: string }) => {
        this.sessions.delete(args.session_id);

        return {
          type: "text",
          text: `Session ${args.session_id} ended`
        };
      }
    });

    // MCP Client Management
    const addMCPClientTool: MCPTool = {
      name: "add_mcp_server",
      description: "Connect to an external MCP server and save to config",
      parameters: z.object({
        name: z.string(),
        command: z.string(),
        args: z.array(z.string()),
        env: z.record(z.string()).optional()
      }),
      execute: async (args: unknown) => {
        const { name, ...config } = args as { name: string } & (MCPClientConfig | MCPHttpConfig);
        try {
          await this.connectToMCPServer(config as MCPClientConfig | MCPHttpConfig, name);

          // Add to config and save
          if (!this.mcpConfig) {
            this.mcpConfig = { mcpServers: {} };
          }
          this.mcpConfig.mcpServers[name] = config as MCPClientConfig | MCPHttpConfig;
          await this.saveMCPConfig();

          return {
            type: "text",
            text: `Connected to MCP server: ${name} and saved to config`
          };
        } catch (error) {
          return {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Failed to connect"}`
          };
        }
      }
    }
    this.server.addTool({
      name: addMCPClientTool.name,
      description: addMCPClientTool.description,
      parameters: addMCPClientTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await addMCPClientTool.execute(args);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(addMCPClientTool.name, addMCPClientTool);;

    // Add method to remove MCP server
    const removeMCPServerTool: MCPTool = {
      name: "remove_mcp_server",
      description: "Disconnect from an MCP server and remove from config",
      parameters: z.object({
        name: z.string()
      }),
      execute: async (args: unknown) => {
        const req = args as { name: string };
        try {
          // Close connection if exists
          const client = this.clients.get(req.name);
          if (client) {
            await client.client.close();
            this.clients.delete(req.name);
          }

          // Remove from config
          if (this.mcpConfig && this.mcpConfig.mcpServers) {
            delete this.mcpConfig.mcpServers[req.name];
            await this.saveMCPConfig();
          }

          return {
            type: "text",
            text: `Removed MCP server: ${req.name}`
          };
        } catch (error) {
          return {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Failed to remove server"}`
          };
        }
      }
    }
    this.server.addTool({
      name: removeMCPServerTool.name,
      description: removeMCPServerTool.description,
      parameters: removeMCPServerTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await removeMCPServerTool.execute(args);
        if (typeof result === "string") {
          return result;
        } else if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return JSON.stringify(result);
      }
    });
    this.tools.set(removeMCPServerTool.name, removeMCPServerTool);    
  }

  // Add method to find MCP config path
  private findMCPConfigPath(): string {
    const paths = [
      // Local project .dispersl directory
      join(process.cwd(), ".dispersl", "mcp.json"),
      // User home directory
      join(process.env.HOME || process.env.USERPROFILE || "", ".dispersl", "mcp.json"),
      // XDG config directory (Linux)
      join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config"), "dispersl", "mcp.json"),
      // System-wide config (fallback)
      "/etc/dispersl/mcp.json"
    ];

    for (const path of paths) {
      try {
        // Check if file exists synchronously for initial setup
        require('fs').accessSync(path, require('fs').constants.F_OK);
        process.stderr.write(`Found MCP config at: ${path}\n`);
        return path;
      } catch (error) {
        // File doesn't exist, continue to next path
      }
    }

    // Default to local project .dispersl directory
    process.stderr.write(`No existing MCP config found, will create at: ${paths[0]}\n`);
    return paths[0];
  }

  private async loadMCPConfig(): Promise<void> {
    try {
      const configContent = await readFile(this.mcpConfigPath, "utf-8");
      this.mcpConfig = JSON.parse(configContent);
      process.stderr.write(`Loaded MCP config from: ${this.mcpConfigPath}\n`);
      if (this.mcpConfig && this.mcpConfig.mcpServers) {
        process.stderr.write(`Found ${Object.keys(this.mcpConfig.mcpServers).length} server(s) in config\n`);
      }
    } catch (error) {
      process.stderr.write(`No MCP config found at ${this.mcpConfigPath}, creating default config\n`);
      // If config doesn't exist, create default
      this.mcpConfig = {
        mcpServers: {}
      };
      await this.saveMCPConfig();
    }
  }

  private async initializeMCPConnections(): Promise<void> {
    try {
      await this.loadMCPConfig();

      if (this.mcpConfig && this.mcpConfig.mcpServers) {
        const serverEntries = Object.entries(this.mcpConfig.mcpServers);
        process.stderr.write(`Initializing ${serverEntries.length} MCP server connections...\n`);

        for (const [name, serverConfig] of serverEntries) {
          if ('type' in serverConfig && (serverConfig.type === 'streamable-http' || serverConfig.type === 'sse')) {
            // Skip HTTP/SSE configs for now
            continue;
          }
          try {
            await this.connectToMCPServer(serverConfig as MCPClientConfig, name);
            process.stderr.write(`✓ Connected to MCP server: ${name}\n`);
          } catch (error) {
            console.error(`✗ Failed to connect to MCP server ${name}:`, error);
          }
        }
      }
    } catch (error) {
      console.error("Error initializing MCP connections:", error);
    }
  }

  private async saveMCPConfig(): Promise<void> {
    const configDir = dirname(this.mcpConfigPath);
    await mkdir(configDir, { recursive: true });
    await writeFile(this.mcpConfigPath, JSON.stringify(this.mcpConfig, null, 2));
  }

  private async connectToMCPServer(config: MCPClientConfig | MCPHttpConfig, name: string): Promise<void> {
    if ('type' in config && (config.type === 'streamable-http' || config.type === 'sse')) {
      // HTTP/SSE MCP client connection
      const url = config.url;
      // Minimal MCPClient interface for HTTP/SSE
      const httpClient: MCPClient = {
        name,
        client: null as any,
        tools: new Map(),
        executeTool: async (toolName: string, args: unknown) => {
          if (config.type === 'streamable-http') {
            // POST to /tools/call
            const response = await fetch(`${url}/tools/call`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(config.env || {}) },
              body: JSON.stringify({ name: toolName, arguments: args })
            });
            if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
            return await response.json();
          } else if (config.type === 'sse') {
            // SSE: not for direct tool call, but can be used for streaming events
            throw new Error('SSE tool execution not implemented');
          }
        }
      };
      // List tools for HTTP
      if (config.type === 'streamable-http') {
        const response = await fetch(`${url}/tools/list`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(config.env || {}) },
          body: JSON.stringify({})
        });
        if (response.ok) {
          const data = await response.json() as { tools?: any[] };
          if (data && Array.isArray(data.tools)) {
            for (const tool of data.tools) {
              httpClient.tools.set(tool.name, {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.inputSchema,
                execute: async (args: unknown) => httpClient.executeTool(tool.name, args)
              });
            }
          }
        }
      }
      this.clients.set(name, httpClient);
      return;
    }
    // At this point, config is MCPClientConfig
    const processConfig = config as MCPClientConfig;
    const transport = new StdioClientTransport({
      command: processConfig.command,
      args: processConfig.args,
      env: processConfig.env
    });
    const client = new Client({
      name,
      version: "0.1.0"
    }, {
      capabilities: {}
    });
    await client.connect(transport);

    // Get available tools
    const toolsResult = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema
    );

    const tools = new Map<string, MCPTool>();
    if (toolsResult && 'tools' in toolsResult && Array.isArray(toolsResult.tools)) {
      for (const tool of toolsResult.tools) {
        tools.set(tool.name, {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.inputSchema,
          execute: async (args: unknown) => {
            const result = await client.request(
              {
                method: "tools/call",
                params: {
                  name: tool.name,
                  arguments: args
                }
              },
              CallToolResultSchema
            );
            return result;
          }
        });
      }
    }

    this.clients.set(name, {
      name,
      client,
      tools,
      executeTool: async (toolName: string, args: unknown) => {
        const tool = tools.get(toolName);
        if (!tool) {
          throw new Error(`Tool ${toolName} not found`);
        }
        return tool.execute(args);
      }
    });
  }

  private async executeMCPTool(toolName: string, args: unknown): Promise<any> {
    // First check if it's a built-in tool
    if (this.isBuiltInTool(toolName)) {
      return this.executeBuiltInTool(toolName, args);
    }

    // Then check all connected MCP clients
    for (const [clientName, client] of this.clients.entries()) {
      try {
        const result = await client.executeTool(toolName, args);
        return result;
      } catch (error) {
        console.error(`Failed to execute tool ${toolName} on client ${clientName}:`, error);
      }
    }

    throw new UserError(`Tool ${toolName} not found in any connected MCP server`);
  }

  private isBuiltInTool(toolName: string): boolean {
    const builtInTools = [
      "list_files",
      "read_file",
      "write_to_file",
      "edit_file",
      "execute_command",
      "detect_test_frameworks",
      "write_test_file",
      "setup_branch_environment",
      "execute_git_command",
      "git_status",
      "git_diff",
      "git_add",
      "git_branch",
      "git_log",
      "git_repo_info",
      "edit_git_infra_file"
    ];
    return builtInTools.includes(toolName);
  }

  private cleanOutput(input: string): string {
    if (!input) return '';

    try {
      // Clean terminal escape sequences and normalize line breaks
      let cleaned = input.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
      cleaned = cleaned.replace(/\\u001b/g, '');
      cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      cleaned = cleaned.replace(/\s+\n/g, '\n').replace(/\n+/g, '\n').trim();

      // Handle JSON responses
      if (cleaned.includes('"status"') && cleaned.includes('"content"')) {
        try {
          const parsedResponse = JSON.parse(cleaned);
          if (typeof parsedResponse === 'object') {
            return JSON.stringify(parsedResponse, null, 2);
          }
        } catch (error) {
          console.debug('Failed to parse as JSON, returning cleaned text');
        }
      }

      return cleaned;
    } catch (error) {
      console.error('Error in cleanOutput:', error);
      return input;
    }
  }

  private async executeDisperslAgent(
    endpoint: string,
    args: BaseRequest & { prompt?: string; url?: string },
    session: AgenticSession
  ): Promise<void> {
    try {
      // Convert MCP tools to OpenRouter format
      const mcpTools = Array.from(this.clients.values()).flatMap(client =>
        Array.from(client.tools.entries()).map(([name, tool]) => ({
          name,
          description: tool.description || "",
          parameters: tool.parameters || {}
        }))
      );

      // Make initial API call to get the agentic response with tools
      const response = await this.callDisperslAPI(endpoint, "POST", {
        ...args,
        conversation_id: session.id,
        mcp: {
          tools: mcpTools
        }
      });

      // Update session context
      session.context = { ...session.context, ...response.context };

      // If response includes tools to execute, process them
      if (response.tools && Array.isArray(response.tools)) {
        await this.processToolCalls(response.tools, session);
      }

      // Update session with final response
      const toolName = endpoint.replace('/', '').replace('/', '_');
      session.tools.set(toolName, {
        name: toolName,
        description: `Tool for ${endpoint}`,
        parameters: {},
        execute: async () => response,
        lastResponse: response
      });

      // Add to conversation history
      session.conversation_history.push({
        role: "assistant",
        content: response.content || "Operation completed",
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error(`Error in executeDisperslAgent for ${endpoint}:`, error);
      throw error;
    }
  }

  private async executeDisperslStream(
    endpoint: string,
    args: BaseRequest & { prompt?: string; url?: string },
    session: AgenticSession
  ): Promise<AsyncGenerator<string, void, unknown>> {
    try {
      // Convert MCP tools to OpenRouter format
      const mcpTools = Array.from(this.clients.values()).flatMap(client =>
        Array.from(client.tools.entries()).map(([name, tool]) => ({
          name,
          description: tool.description || "",
          parameters: tool.parameters || {}
        }))
      );

      // Make initial API call to get the agentic response with tools
      const response = await fetch(`${DISPERSL_API_BASE}${endpoint}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...args,
          conversation_id: session.id,
          mcp: {
            tools: mcpTools
          }
        })
      });

      if (!response.body) throw new Error("No response body for NDJSON stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      let fullResponse = '';

      async function* ndjsonStream() {
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          let lines = buffer.split('\n');
          buffer = lines.pop()!; // last line may be incomplete
          for (const line of lines) {
            if (!line.trim()) continue;
            let data;
            try {
              data = JSON.parse(line);
            } catch (e) {
              continue; // skip malformed lines
            }
            // Handle NDJSON chunk
            if (data.status === 'processing') {
              if (data.content) {
                yield data.content;
                fullResponse += data.content;
              }
              // Optionally handle tools, knowledge, audio, etc.
            } else if (data.status === 'complete') {
              // Optionally yield a completion signal
              return;
            } else if (data.status === 'error') {
              throw new Error(data.error?.message || data.message || 'Unknown error');
            }
          }
        }
      }

      // Update session with final response after stream ends
      const self = this;
      async function* sessionStream() {
        for await (const chunk of ndjsonStream()) {
          yield chunk;
        }
        // Update session with final response
        const toolName = endpoint.replace('/', '').replace('/', '_');
        session.tools.set(toolName, {
          name: toolName,
          description: `Tool for ${endpoint}`,
          parameters: {},
          execute: async () => ({}),
          lastResponse: {
            content: fullResponse,
            context: session.context
          }
        });
        session.conversation_history.push({
          role: "assistant",
          content: fullResponse || "Operation completed",
          timestamp: new Date().toISOString()
        });
      }

      return sessionStream();
    } catch (error) {
      console.error(`Error in executeDisperslStream for ${endpoint}:`, error);
      throw error;
    }
  }

  private async processToolCalls(toolCalls: ToolCall[], session: AgenticSession): Promise<ToolResponse[]> {
    const toolResponses: ToolResponse[] = [];
    let shouldContinue = true;

    for (const toolCall of toolCalls) {
      if (!shouldContinue) break;

      try {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        console.log(`Executing tool: ${functionName}`);

        let response: any;

        // Handle special control tools
        if (functionName === "end_session") {
          shouldContinue = false;
          toolResponses.push({
            status: "SUCCESS",
            message: "Session ended",
            tool: functionName,
            output: ""
          });
          continue;
        }

        // Handle handover to another agent
        if (functionName === "handover_task") {
          const handoverContent = JSON.parse(functionArgs.content);
          const { endpoint, prompt, ...additionalArgs } = handoverContent;

          response = await this.callDisperslAPI(endpoint, "POST", {
            prompt,
            ...additionalArgs,
            conversation_id: session.id
          });

          toolResponses.push({
            status: "SUCCESS",
            message: "Task handed over successfully",
            tool: functionName,
            output: this.cleanOutput(response.content || "")
          });

          // If handover includes more tools, process them
          if (response.tools) {
            const additionalResponses = await this.processToolCalls(response.tools, session);
            toolResponses.push(...additionalResponses);
          }
          continue;
        }

        // Execute the tool
        response = await this.executeMCPTool(functionName, functionArgs);

        const cleanedOutput = this.cleanOutput(response.content || response.output || JSON.stringify(response));

        toolResponses.push({
          status: "SUCCESS",
          message: "Operation completed successfully",
          tool: functionName,
          output: cleanedOutput
        });

      } catch (error) {
        console.error(`Tool execution error for ${toolCall.function.name}:`, error);
        toolResponses.push({
          status: "FAILURE",
          message: `Error executing tool: ${error instanceof Error ? error.message : "Unknown error"}`,
          tool: toolCall.function.name,
          output: ""
        });
      }
    }

    // Continue conversation with tool responses if session should continue
    if (shouldContinue && toolResponses.length > 0) {
      try {
        const response = await this.callDisperslAPI("/chat", "POST", {
          prompt: JSON.stringify({
            tool_responses: toolResponses,
            context: session.context
          }),
          conversation_id: session.id,
          model: "meta-llama/llama-4-maverick:free"
        });

        // Update session with continued conversation
        session.conversation_history.push({
          role: "assistant",
          content: response.content,
          timestamp: new Date().toISOString()
        });

        // If the response includes more tools, execute them recursively
        if (response.tools && Array.isArray(response.tools)) {
          const additionalResponses = await this.processToolCalls(response.tools, session);
          toolResponses.push(...additionalResponses);
        }
      } catch (error) {
        console.error("Error continuing conversation:", error);
      }
    }

    return toolResponses;
  }

  private async executeBuiltInTool(functionName: string, functionArgs: any): Promise<BaseResponse> {
    const builtInTools: Record<string, (args: any) => Promise<BaseResponse>> = {
      list_files: async (args) => {
        try {
          const { path = "." } = args;
          const entries = await readdir(path, { withFileTypes: true });
          const files = await Promise.all(
            entries.map(async (entry) => {
              const stats = await stat(`${path}/${entry.name}`);
              return {
                name: entry.name,
                type: entry.isDirectory() ? "directory" : "file",
                size: stats.size,
                modified: stats.mtime
              };
            })
          );
          return { status: "success", content: JSON.stringify(files) };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to list files" };
        }
      },

      read_file: async (args) => {
        try {
          const { path } = args;
          if (!path) throw new Error("Path is required");
          const content = await readFile(path, "utf-8");
          return { status: "success", content };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to read file" };
        }
      },

      write_to_file: async (args) => {
        try {
          const { path, content } = args;
          if (!path || content === undefined) throw new Error("Path and content are required");
          await writeFile(path, content);
          return { status: "success", content: `File written to ${path}` };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to write file" };
        }
      },

      edit_file: async (args) => {
        try {
          const { path, content } = args;
          if (!path || content === undefined) throw new Error("Path and content are required");
          await writeFile(path, content);
          return { status: "success", content: `File edited at ${path}` };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to edit file" };
        }
      },

      execute_command: async (args) => {
        try {
          const { command } = args;
          if (!command) throw new Error("Command is required");
          const { stdout, stderr } = await execAsync(command);
          return { status: "success", content: stdout || stderr };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to execute command" };
        }
      },

      detect_test_frameworks: async (args) => {
        try {
          const { path = "." } = args;
          const entries = await readdir(path, { withFileTypes: true });
          const frameworks = new Set<string>();
          const configFiles = new Set<string>();

          try {
            const packageJson = JSON.parse(await readFile(`${path}/package.json`, "utf-8"));
            const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
            if (deps.jest) frameworks.add("jest");
            if (deps.mocha) frameworks.add("mocha");
            if (deps.vitest) frameworks.add("vitest");
            if (deps.cypress) frameworks.add("cypress");
          } catch (e) {}

          for (const entry of entries) {
            if (entry.isFile()) {
              const name = entry.name.toLowerCase();
              if (name.includes("jest.config")) configFiles.add(name);
              if (name.includes("vitest.config")) configFiles.add(name);
              if (name.includes("cypress.config")) configFiles.add(name);
              if (name === "mocha.opts") configFiles.add(name);
            }
          }

          return {
        status: "success",
            content: JSON.stringify({
              frameworks: Array.from(frameworks),
              config_files: Array.from(configFiles)
            })
          };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to detect test frameworks" };
        }
      },

      write_test_file: async (args) => {
        try {
          const { path, content } = args;
          if (!path || content === undefined) throw new Error("Path and content are required");
          await writeFile(path, content);
          return { status: "success", content: `Test file written to ${path}` };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to write test file" };
        }
      },

      setup_branch_environment: async (args) => {
        try {
          const { command } = args;
          if (!command) throw new Error("Command is required");
          const { stdout } = await execAsync(command);
          const branchMatch = stdout.match(/Switched to branch '(.+)'/);
          const branch = branchMatch ? branchMatch[1] : "unknown";
          return { status: "success", content: JSON.stringify({ branch }) };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to setup branch environment" };
        }
      },

      execute_git_command: async (args) => {
        try {
          const { command } = args;
          if (!command) throw new Error("Command is required");
          const { stdout, stderr } = await execAsync(`git ${command}`);
          return { status: "success", content: stdout || stderr };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to execute git command" };
        }
      },

      git_status: async () => {
        try {
          const { stdout } = await execAsync("git status");
          return { status: "success", content: stdout };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to get git status" };
        }
      },

      git_diff: async (args) => {
        try {
          const { path } = args;
          const command = path ? `git diff ${path}` : "git diff";
          const { stdout } = await execAsync(command);
          return { status: "success", content: stdout };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to get git diff" };
        }
      },

      git_add: async (args) => {
        try {
          const { path } = args;
          const command = path ? `git add ${path}` : "git add .";
          const { stdout } = await execAsync(command);
          return { status: "success", content: stdout || "Files staged successfully" };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to stage files" };
        }
      },

      git_branch: async (args) => {
        try {
          const { action, name } = args;
          let command = "git branch";
          if (action === "create" && name) command = `git checkout -b ${name}`;
          else if (action === "delete" && name) command = `git branch -d ${name}`;
          else if (action === "list") command = "git branch";
          const { stdout } = await execAsync(command);
          return { status: "success", content: stdout };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to manage branches" };
        }
      },

      git_log: async (args) => {
        try {
          const { limit = 10, path } = args;
          const command = path ? `git log -n ${limit} -- ${path}` : `git log -n ${limit}`;
          const { stdout } = await execAsync(command);
          return { status: "success", content: stdout };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to get git log" };
        }
      },

      git_repo_info: async () => {
        try {
          const [remote, branch] = await Promise.all([
            execAsync("git remote -v"),
            execAsync("git branch --show-current")
          ]);
          return {
        status: "success",
            content: JSON.stringify({
              remote: remote.stdout.trim(),
              current_branch: branch.stdout.trim()
            })
          };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to get repository info" };
        }
      },

      edit_git_infra_file: async (args) => {
        try {
          const { path, content } = args;
          if (!path || content === undefined) throw new Error("Path and content are required");
          await writeFile(path, content);
          return { status: "success", content: `Git infrastructure file written to ${path}` };
        } catch (error) {
          return { status: "error", error: error instanceof Error ? error.message : "Failed to edit git infrastructure file" };
        }
      }
    };

    const tool = builtInTools[functionName];
    if (tool) {
      return await tool(functionArgs);
    }

    throw new Error(`Built-in tool ${functionName} not implemented`);
  }

  public async start(port: number = 8080): Promise<void> {
    // Start as MCP server
    const transport = new StdioServerTransport();
    const server = new Server(
      {
        name: "dispersl-mcp",
        version: "0.1.0"
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    // Setup server handlers
    server.setRequestHandler(z.object({
      method: z.literal("tools/list")
    }), async () => {
      const tools = Array.from(this.tools.keys()).map(name => {
        const tool = this.tools.get(name);
        let inputSchema;
        if (tool?.parameters && tool.parameters instanceof ZodType) {
          inputSchema = zodToJsonSchema(tool.parameters);
        } else {
          inputSchema = { type: 'object', properties: {} };
        }
        return {
          name,
          description: tool?.description || "",
          inputSchema
        };
      });
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const tool = this.tools.get(name);
      if (!tool) {
        throw new Error(`Tool ${name} not found`);
      }
      const result = await tool.execute(args);
      if (typeof result === "object" && result !== null) {
        return result;
      }
      return { result };
    });

    await server.connect(transport);
    process.stderr.write(`Dispersl MCP Server started and listening on stdio\n`);

    // Add this to ensure the process doesn't exit immediately
    if (process.stdin.isTTY) {
      process.stderr.write("Server is running. Press Ctrl+C to stop.\n");
    }
  }

  public async stop(): Promise<void> {
    // Close all MCP client connections
    for (const [name, client] of this.clients.entries()) {
      try {
        await client.client.close();
        console.log(`Closed connection to MCP client: ${name}`);
      } catch (error) {
        console.error(`Error closing MCP client ${name}:`, error);
      }
    }

    // Clear sessions
    this.sessions.clear();

    console.log("Dispersl MCP Server stopped");
  }

  public async getTools(): Promise<Map<string, MCPTool>> {
    return this.tools;
  }

  private async callDisperslAPI(endpoint: string, method: string, body?: unknown): Promise<any> {
    if (!this.apiKey) {
      throw new Error("DISPERSL_API_KEY is required");
    }
    const response = await fetch(`${DISPERSL_API_BASE}${endpoint}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      throw new Error(`API call failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
}

// Content Helper Functions
export const imageContent = async (
  input: { buffer: Buffer } | { path: string } | { url: string }
): Promise<ImageContent> => {
  let rawData: Buffer;

  try {
    if ("url" in input) {
      const response = await fetch(input.url);
      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }
      rawData = Buffer.from(await response.arrayBuffer());
    } else if ("path" in input) {
      rawData = await readFile(input.path);
    } else if ("buffer" in input) {
      rawData = input.buffer;
    } else {
      throw new Error("Invalid input: Provide a valid 'url', 'path', or 'buffer'");
    }

    const mimeType = await fileTypeFromBuffer(rawData);
    if (!mimeType || !mimeType.mime.startsWith("image/")) {
      console.warn(`Warning: Content may not be a valid image. Detected MIME: ${mimeType?.mime || "unknown"}`);
    }

    return {
      data: rawData.toString("base64"),
      mimeType: mimeType?.mime ?? "image/png",
      type: "image",
    };
  } catch (error) {
    throw new UserError(
      `Failed to process image: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

export const audioContent = async (
  input: { buffer: Buffer } | { path: string } | { url: string }
): Promise<AudioContent> => {
  let rawData: Buffer;

  try {
    if ("url" in input) {
      const response = await fetch(input.url);
      if (!response.ok) {
        throw new Error(`Server responded with status: ${response.status}`);
      }
      rawData = Buffer.from(await response.arrayBuffer());
    } else if ("path" in input) {
      rawData = await readFile(input.path);
    } else if ("buffer" in input) {
      rawData = input.buffer;
    } else {
      throw new Error("Invalid input: Provide a valid 'url', 'path', or 'buffer'");
    }

    const mimeType = await fileTypeFromBuffer(rawData);
    if (!mimeType || !mimeType.mime.startsWith("audio/")) {
      console.warn(`Warning: Content may not be a valid audio file. Detected MIME: ${mimeType?.mime || "unknown"}`);
    }

    return {
      data: rawData.toString("base64"),
      mimeType: mimeType?.mime ?? "audio/mpeg",
      type: "audio",
    };
  } catch (error) {
    throw new UserError(
      `Failed to process audio: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

// Export default instance
export default DisperslMCPServer;

if (process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server.ts') || process.argv[1].includes('dispersl-mcp'))) {
  // Get API key from environment variable if not provided as argument
  let apiKey: string | undefined = undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--api-key=')) {
      apiKey = arg.split('=')[1];
    }
  }
  if (!apiKey) {
    apiKey = process.env.DISPERSL_API_KEY;
  }
  const server = new DisperslMCPServer(apiKey);

  // Setup graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Received SIGINT, shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });

  server.start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}