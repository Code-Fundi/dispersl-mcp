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
import { EventSource } from "eventsource";

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

// Main Server Class
export class DisperslMCPServer {
  private server: FastMCP;
  private clients: Map<string, MCPClient>;
  private sessions: Map<string, AgenticSession>;
  private mcpConfig: MCPConfig | null = null;
  private mcpConfigPath: string;
  private tools: Map<string, MCPTool>;
  private apiKey?: string;
  private chatModel?: string | null;
  private planModel?: string | null;
  private coderModel?: string | null;
  private testerModel?: string | null;
  private gitModel?: string | null;
  private docsModel?: string | null;
  private mcpTools: Array<{ name: string; description: string; parameters: any }> = [];

  constructor(apiKey?: string) {
    // Get API key from argument or environment variable
    this.apiKey = apiKey || process.env.DISPERSL_API_KEY;

    // Get default models from argument or environment variable
    this.chatModel = process.env.DISPERSL_CHAT_MODEL || null;
    this.planModel = process.env.DISPERSL_PLAN_MODEL || null;
    this.coderModel = process.env.DISPERSL_CODE_MODEL || null;
    this.testerModel = process.env.DISPERSL_TEST_MODEL || null;
    this.gitModel = process.env.DISPERSL_GIT_MODEL || null;
    this.docsModel = process.env.DISPERSL_DOCS_MODEL || null;

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
      name: "dispersl_code_agent",
      description: "Generate code files and codebases based on a prompt using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        task_id: z.string().optional(),
        knowledge: z.string().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as BuildCodeRequest;
        const sessionId = req.task_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        // Set default model if not provided
        if (!req.model && this.coderModel) {
          req.model = this.coderModel;
        }
        const session = this.sessions.get(sessionId)!;
        try {
          // Use NDJSON streaming
          const stream = this.ndjsonStream("/agent/code", req, session);
          let fullResponse = '';
          for await (const chunk of stream) {
            if (chunk.content) fullResponse += chunk.content;
          }
          session.tools.set("dispersl_code_agent", {
            name: "dispersl_code_agent",
            description: buildCodeTool.description,
            parameters: buildCodeTool.parameters,
            execute: async () => fullResponse,
            lastResponse: { content: fullResponse }
          });
          return {
            type: "text",
            text: fullResponse || "Code generation completed"
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
      name: "dispersl_testing_agent",
      description: "Generate end to end tests based on a prompt using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        task_id: z.string().optional(),
        knowledge: z.string().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as BuildTestsRequest;
        const sessionId = req.task_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        // Set default model if not provided
        if (!req.model && this.testerModel) {
          req.model = this.testerModel;
        }
        const session = this.sessions.get(sessionId)!;
        try {
          // Use NDJSON streaming
          const stream = this.ndjsonStream("/agent/tests", req, session);
          let fullResponse = '';
          for await (const chunk of stream) {
            if (chunk.content) fullResponse += chunk.content;
          }
          session.tools.set("dispersl_testing_agent", {
            name: "dispersl_testing_agent",
            description: buildTestsTool.description,
            parameters: buildTestsTool.parameters,
            execute: async () => fullResponse,
            lastResponse: { content: fullResponse }
          });
          return {
            type: "text",
            text: fullResponse || "Test generation completed"
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
      name: "dispersl_git_agent",
      description: "Execute codebase versioning operations with Git based on a prompt using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        task_id: z.string().optional(),
        knowledge: z.string().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as GitOperationRequest;
        const sessionId = req.task_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        // Set default model if not provided
        if (!req.model && this.gitModel) {
          req.model = this.gitModel;
        }
        const session = this.sessions.get(sessionId)!;
        try {
          // Use NDJSON streaming
          const stream = this.ndjsonStream("/agent/git", req, session);
          let fullResponse = '';
          for await (const chunk of stream) {
            if (chunk.content) fullResponse += chunk.content;
          }
          session.tools.set("dispersl_git_agent", {
            name: "dispersl_git_agent",
            description: gitOperationTool.description,
            parameters: gitOperationTool.parameters,
            execute: async () => fullResponse,
            lastResponse: { content: fullResponse }
          });
          return {
            type: "text",
            text: fullResponse || "Git operation completed"
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
      name: "dispersl_new_docs_agent",
      description: "Generate file by file technical documentation for a code repository using agentic execution",
      parameters: z.object({
        url: z.string(),
        branch: z.string().optional(),
        team_access: z.boolean().optional(),
        model: z.string().optional(),
        context: z.string().optional(),
        task_id: z.string().optional(),
        knowledge: z.string().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as GenerateDocsRequest;
        const sessionId = req.task_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        // Set default model if not provided
        if (!req.model && this.docsModel) {
          req.model = this.docsModel;
        }
        const session = this.sessions.get(sessionId)!;
        try {
          // Use NDJSON streaming
          const stream = this.ndjsonStream("/docs/repo", req, session);
          let fullResponse = '';
          for await (const chunk of stream) {
            if (chunk.content) fullResponse += chunk.content;
          }
          session.tools.set("dispersl_new_docs_agent", {
            name: "dispersl_new_docs_agent",
            description: generateDocsTool.description,
            parameters: generateDocsTool.parameters,
            execute: async () => fullResponse,
            lastResponse: { content: fullResponse }
          });
          return {
            type: "text",
            text: fullResponse || "Documentation generation completed"
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
      name: "dispersl_chat_agent",
      description: "Chat with the Dispersl agent to get knowledge or insights about codebases using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        task_id: z.string().optional(),
        knowledge: z.string().optional(),
        memory: z.boolean().optional(),
        voice: z.boolean().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as ChatRequest;
        const sessionId = req.task_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        // Set default model if not provided
        if (!req.model && this.chatModel) {
          req.model = this.chatModel;
        }
        const session = this.sessions.get(sessionId)!;
        try {
          session.conversation_history.push({
            role: "user",
            content: req.prompt,
            timestamp: new Date().toISOString()
          });
          // Use NDJSON streaming
          const stream = this.ndjsonStream("/agent/chat", req, session);
          let fullResponse = '';
          for await (const chunk of stream) {
            if (chunk.content) fullResponse += chunk.content;
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
    this.tools.set(addMCPClientTool.name, addMCPClientTool);

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

    // Models
    const getModelsTool: MCPTool = {
      name: "get_models",
      description: "List available AI models",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/models", "GET");
          return { type: "text", text: JSON.stringify(result) };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getModelsTool.name,
      description: getModelsTool.description,
      parameters: getModelsTool.parameters as any,
      execute: async (args: unknown, _context: any): Promise<any> => {
        const result = await getModelsTool.execute(args);
        if (result && typeof result === "object" && "type" in result && result.type === "data") {
          return result;
        } else if (typeof result === "string") return result;
        if (result && typeof result === "object" && "text" in result) {
          if (!('type' in result)) {
            return { ...(result as any), type: "text" } as import("./types.js").TextContent;
          }
          return result as import("./types.js").TextContent;
        }
        return result;
      }
    });
    this.tools.set(getModelsTool.name, getModelsTool);

    // API Keys
    const getKeysTool: MCPTool = {
      name: "get_keys",
      description: "Get API keys for the authenticated user",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/keys", "GET");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getKeysTool.name,
      description: getKeysTool.description,
      parameters: getKeysTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getKeysTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getKeysTool.name, getKeysTool);

    const newKeyTool: MCPTool = {
      name: "new_key",
      description: "Generate new API key",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/keys/new", "GET");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: newKeyTool.name,
      description: newKeyTool.description,
      parameters: newKeyTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await newKeyTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(newKeyTool.name, newKeyTool);

    // Tasks
    const createTaskTool: MCPTool = {
      name: "create_task",
      description: "Create a new task",
      parameters: z.object({ body: z.object({}).passthrough() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint("/tasks/new", "POST", args.body);
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: createTaskTool.name,
      description: createTaskTool.description,
      parameters: createTaskTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await createTaskTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(createTaskTool.name, createTaskTool);

    const editTaskTool: MCPTool = {
      name: "edit_task",
      description: "Edit a task by ID",
      parameters: z.object({ id: z.string(), body: z.object({}).passthrough() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint(`/tasks/${args.id}/edit`, "POST", args.body);
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: editTaskTool.name,
      description: editTaskTool.description,
      parameters: editTaskTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await editTaskTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(editTaskTool.name, editTaskTool);

    const getTasksTool: MCPTool = {
      name: "get_tasks",
      description: "Get all tasks",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/tasks", "GET");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getTasksTool.name,
      description: getTasksTool.description,
      parameters: getTasksTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getTasksTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getTasksTool.name, getTasksTool);

    const getTaskTool: MCPTool = {
      name: "get_task",
      description: "Get a task by ID",
      parameters: z.object({ id: z.string() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint(`/tasks/${args.id}`, "GET");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getTaskTool.name,
      description: getTaskTool.description,
      parameters: getTaskTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getTaskTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getTaskTool.name, getTaskTool);

    const deleteTaskTool: MCPTool = {
      name: "cancel_task",
      description: "Cancel a task by ID",
      parameters: z.object({ id: z.string() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint(`/tasks/${args.id}/cancel`, "DELETE");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: deleteTaskTool.name,
      description: deleteTaskTool.description,
      parameters: deleteTaskTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await deleteTaskTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(deleteTaskTool.name, deleteTaskTool);

    // Steps
    const editStepTool: MCPTool = {
      name: "edit_step",
      description: "Edit a step by ID",
      parameters: z.object({ id: z.string(), body: z.object({}).passthrough() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint(`/steps/${args.id}/edit`, "POST", args.body);
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: editStepTool.name,
      description: editStepTool.description,
      parameters: editStepTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await editStepTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(editStepTool.name, editStepTool);

    const getStepsTool: MCPTool = {
      name: "get_steps",
      description: "Get all steps",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/steps", "GET");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getStepsTool.name,
      description: getStepsTool.description,
      parameters: getStepsTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getStepsTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getStepsTool.name, getStepsTool);

    const getStepTool: MCPTool = {
      name: "get_step",
      description: "Get a step by ID",
      parameters: z.object({ id: z.string() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint(`/steps/${args.id}`, "GET");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getStepTool.name,
      description: getStepTool.description,
      parameters: getStepTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getStepTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getStepTool.name, getStepTool);

    const deleteStepTool: MCPTool = {
      name: "cancel_step",
      description: "Cancel a step by ID",
      parameters: z.object({ id: z.string() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint(`/steps/${args.id}/cancel`, "DELETE");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: deleteStepTool.name,
      description: deleteStepTool.description,
      parameters: deleteStepTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await deleteStepTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(deleteStepTool.name, deleteStepTool);

    // Stats
    const getUsageStatsTool: MCPTool = {
      name: "get_usage_stats",
      description: "Get usage stats",
      parameters: z.object({ body: z.object({}).passthrough().optional() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint("/stats/usage", "POST", args.body);
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getUsageStatsTool.name,
      description: getUsageStatsTool.description,
      parameters: getUsageStatsTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getUsageStatsTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getUsageStatsTool.name, getUsageStatsTool);

    const getLanguageStatsTool: MCPTool = {
      name: "get_language_stats",
      description: "Get language usage stats",
      parameters: z.object({ body: z.object({}).passthrough().optional() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint("/stats/language", "POST", args.body);
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getLanguageStatsTool.name,
      description: getLanguageStatsTool.description,
      parameters: getLanguageStatsTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getLanguageStatsTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getLanguageStatsTool.name, getLanguageStatsTool);

    const getAgentStatsTool: MCPTool = {
      name: "get_agent_stats",
      description: "Get agent query stats",
      parameters: z.object({ body: z.object({}).passthrough().optional() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint("/stats/agent", "POST", args.body);
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getAgentStatsTool.name,
      description: getAgentStatsTool.description,
      parameters: getAgentStatsTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getAgentStatsTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getAgentStatsTool.name, getAgentStatsTool);

    // History
    const getTaskHistoryTool: MCPTool = {
      name: "get_task_history",
      description: "Get task history by ID",
      parameters: z.object({ id: z.string(), body: z.object({}).passthrough().optional() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint(`/history/${args.id}`, "GET", args.body);
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getTaskHistoryTool.name,
      description: getTaskHistoryTool.description,
      parameters: getTaskHistoryTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getTaskHistoryTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getTaskHistoryTool.name, getTaskHistoryTool);

    const getStepHistoryTool: MCPTool = {
      name: "get_step_history",
      description: "Get step history by ID",
      parameters: z.object({ id: z.string(), body: z.object({}).passthrough().optional() }),
      execute: async (args: any) => {
        try {
          const result = await this.callJsonEndpoint(`/history/${args.id}/step`, "GET", args.body);
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: getStepHistoryTool.name,
      description: getStepHistoryTool.description,
      parameters: getStepHistoryTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await getStepHistoryTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(getStepHistoryTool.name, getStepHistoryTool);

    // Fetch & Health
    const fetchApiRootTool: MCPTool = {
      name: "fetch_api_root",
      description: "Fetch API root (utility endpoint)",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/fetch", "GET");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: fetchApiRootTool.name,
      description: fetchApiRootTool.description,
      parameters: fetchApiRootTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await fetchApiRootTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(fetchApiRootTool.name, fetchApiRootTool);

    const healthCheckTool: MCPTool = {
      name: "health_check",
      description: "Health check endpoint",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/health", "GET");
          return { type: "data", data: result };
        } catch (error) {
          return { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` };
        }
      }
    };
    this.server.addTool({
      name: healthCheckTool.name,
      description: healthCheckTool.description,
      parameters: healthCheckTool.parameters as any,
      execute: (async (args: unknown, _context: any) => {
        const result = await healthCheckTool.execute(args);
        if (
          result &&
          typeof result === "object" &&
          "type" in (result as any) &&
          typeof (result as any).type === "string" &&
          (result as any).type === "data"
        ) {
          return result;
        } else if (typeof result === "string") return result;
        if (
          result &&
          typeof result === "object" &&
          "text" in (result as any)
        ) {
          if (!("type" in (result as any))) {
            return { ...(result as any), type: "text" };
          }
          return result;
        }
        return result;
      }) as any
    });
    this.tools.set(healthCheckTool.name, healthCheckTool);

    // Remove the new *_agentic tools if present (and do not add them)
    this.tools.delete("plan_agentic");
    this.tools.delete("build_code_agentic");
    this.tools.delete("build_tests_agentic");
    this.tools.delete("build_git_agentic");
    this.tools.delete("generate_docs_agentic");
    this.tools.delete("chat_agentic");

    // Plan Agent
    const planTool: MCPTool = {
      name: "dispersl_plan_agent",
      description: "Multi-agent task dispersion using agentic execution (plan agent)",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.string().optional(),
        task_id: z.string().optional(),
        knowledge: z.string().optional(),
        memory: z.boolean().optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown) => {
        const req = args as ChatRequest; // Plan agent uses similar structure
        const sessionId = req.task_id || uuidv4();
        if (!this.sessions.has(sessionId)) {
          this.sessions.set(sessionId, {
            id: sessionId,
            tools: new Map(),
            context: {},
            conversation_history: [],
            active_tools: new Set()
          });
        }
        // Set default model if not provided
        if (!req.model && this.planModel) {
          req.model = this.planModel;
        }
        const session = this.sessions.get(sessionId)!;
        try {
          session.conversation_history.push({
            role: "user",
            content: req.prompt,
            timestamp: new Date().toISOString()
          });
          // Use NDJSON streaming
          const stream = this.ndjsonStream("/agent/plan", req, session);
          let fullResponse = '';
          for await (const chunk of stream) {
            if (chunk.content) fullResponse += chunk.content;
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
      name: planTool.name,
      description: planTool.description,
      parameters: planTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await planTool.execute(args);
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
    this.tools.set(planTool.name, planTool);
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
      // After all connections, update mcpTools
      this.updateMcpTools();
    } catch (error) {
      console.error("Error initializing MCP connections:", error);
    }
  }

  private updateMcpTools() {
    this.mcpTools = Array.from(this.clients.values()).flatMap(client =>
      Array.from(client.tools.entries()).map(([name, tool]) => ({
        name,
        description: tool.description || "",
        parameters: tool.parameters || {}
      }))
    );
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
            throw new Error('SSE tool execution not supported. Use event subscription instead.');
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
      // SSE support: connect and expose event subscription
      if (config.type === 'sse') {
        // Helper to convert config.env to headers for fetch
        const envHeaders = config.env ? { ...config.env } : {};
        // Use fetch override to inject headers
        const eventSource = new EventSource(url, {
          fetch: (input: any, init: any = {}) => {
            return (fetch as any)(input, {
              ...init,
              headers: {
                ...(init.headers || {}),
                ...envHeaders
              }
            });
          }
        } as any); // Type assertion to allow fetch override
        // Store listeners for this client
        const listeners: Array<{ event: string, handler: (data: any) => void }> = [];
        // Attach a subscribe method to the client for SSE events
        (httpClient as any).subscribeEvent = (event: string, handler: (data: any) => void) => {
          eventSource.addEventListener(event, (e: MessageEvent) => {
            let data = e.data;
            try { data = JSON.parse(e.data); } catch {}
            handler(data);
          });
          listeners.push({ event, handler });
        };
        // Optionally, handle errors and reconnection
        eventSource.addEventListener('error', (err: any) => {
          console.error(`[SSE][${name}] Error:`, err);
        });
        (httpClient as any).eventSource = eventSource;
      }
      this.clients.set(name, httpClient);
      this.updateMcpTools();
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
    this.updateMcpTools();
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
      // Use up-to-date mcpTools
      const mcpTools = this.mcpTools;

      // Make initial API call to get the agentic response with tools
      const response = await this.callDisperslAPI(endpoint, "POST", {
        ...args,
        task_id: session.id,
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
      // Use up-to-date mcpTools
      const mcpTools = this.mcpTools;

      // Make initial API call to get the agentic response with tools
      const response = await fetch(`${DISPERSL_API_BASE}${endpoint}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...args,
          task_id: session.id,
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
          const { agent_name, prompt, ...additionalArgs } = handoverContent;
          var endpoint = '';

          switch (agent_name) {
            case "code":
              endpoint = '/agent/code'
              break;
            case "test":
              endpoint = '/agent/test'
              break;
            case "git":
              endpoint = '/agent/git'
              break;
            case "docs":
              endpoint = '/agent/documentation/repo'
              break; 
            case "chat":
              endpoint = '/agent/chat'
              break;
            case "plan":
              endpoint = '/agent/plan'
              break;
            default:
              break;
          }

          response = await this.callDisperslAPI(endpoint, "POST", {
            prompt,
            ...additionalArgs,
            task_id: session.id
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
        const response = await this.callDisperslAPI("/agent/chat", "POST", {
          prompt: JSON.stringify({
            tool_responses: toolResponses,
            context: session.context
          }),
          task_id: session.id,
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

  // NDJSON Streaming Helper (refactored)
  private async *ndjsonStream(endpoint: string, args: any, session?: AgenticSession): AsyncGenerator<any, void, unknown> {
    const response = await fetch(`${DISPERSL_API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(args)
    });
    if (!response.body) throw new Error("No response body for NDJSON stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    let fullResponse = '';
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
        // Optionally accumulate content for session
        if (data.content) fullResponse += data.content;
        yield data;
      }
    }
    // Optionally update session with final response
    if (session) {
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
  }

  // Generic application/json endpoint helper
  private async callJsonEndpoint(endpoint: string, method: string = "GET", body?: any): Promise<any> {
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