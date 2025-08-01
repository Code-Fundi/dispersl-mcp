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
  ChatRequest,
  MCPConfig,
  UserError,
  MCPTool,
  MCPClient,
  AgenticSession,
  MCPClientConfig,
  GitOperationRequest,
  GenerateDocsRequest,
  Content,
  ImageContent,
  AudioContent,
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
const DISPERSL_API_BASE = test ? "http://localhost:3001/v1" : "https://api.dispersl.com/v1";

// Interface for a tool call received from the Dispersl API
interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
}

// Interface for a tool execution response
interface ToolResponse {
  status: "SUCCESS" | "FAILURE";
  message: string;
  tool: string;
  output: string;
}

// Interface for handover information
interface HandoverInfo {
  endpoint: string;
  prompt: string;
  additionalArgs: Record<string, any>;
}

// Add this helper at the top after imports
function logIfTest(...args: any[]) {
  if (test) {
    process.stderr.write(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ') + '\n');
  }
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
      version: "0.1.1",
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
    // Plan Agent
    const planTool: MCPTool = {
      name: "dispersl_plan_agent",
      description: "Multi-agent task dispersion using agentic execution (plan agent). Agent choices can either be use 'code', 'test', 'git', 'docs' as the agent choices",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.array(z.string()).optional(),
        task_id: z.string().optional(),
        knowledge: z.array(z.string()).optional(),
        memory: z.boolean().optional(),
        agent_choice: z.array(z.string()).nonempty(),
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
            content: [
              {
                type: "text",
                text: fullResponse
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
              }
            ]
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

    // Code Generation
    const buildCodeTool: MCPTool = {
      name: "dispersl_code_agent",
      description: "Generate code files and codebases based on a prompt using agentic execution",
      parameters: z.object({
        prompt: z.string(),
        model: z.string().optional(),
        context: z.array(z.string()).optional(),
        task_id: z.string().optional(),
        knowledge: z.array(z.string()).optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown, context?: { 
        log?: { info: (message: string, data?: any) => void; warn: (message: string, data?: any) => void; error: (message: string, data?: any) => void; debug: (message: string, data?: any) => void };
        streamContent?: (content: { type: string; text: string } | { type: string; text: string }[]) => Promise<void>;
        reportProgress?: (progress: { progress: number; total?: number }) => Promise<void>;
      }) => {
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
          // Stream initial status
          context?.streamContent?.({
            type: "text",
            text: `🚀 Starting agentic execution loop for /agent/code\n\n`
          });

          // Use executeDisperslAgent for full agentic loop
          await this.executeDisperslAgent("/agent/code", req, session, (message) => {
            context?.streamContent?.({
              type: "text",
              text: message + "\n"
            });
          });
          const toolName = "dispersl_code_agent";
          const sessionTool = session.tools.get(toolName);
          
          // Compile all responses from the session
          const compiledResponse = this.compileSessionResponses(session, "dispersl_code_agent");
          
          // Stream completion message
          context?.streamContent?.({
            type: "text",
            text: `🎉 **Agentic execution completed!**\n\n`
          });
          
          return {
            content: [
              {
                type: "text",
                text: compiledResponse || sessionTool?.lastResponse?.content || "Code generation completed"
              }
            ]
          };
        } catch (error) {
          logIfTest(`Code generation error: ${error}`);
          context?.log?.error("Code generation failed", { error: error instanceof Error ? error.message : "Unknown error" });
          context?.streamContent?.({
            type: "text",
            text: `❌ **Error:** ${error instanceof Error ? error.message : "Unknown error"}\n\n`
          });
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
              }
            ]
          };
        }
      }
    };
    this.server.addTool({
      name: buildCodeTool.name,
      description: buildCodeTool.description,
      parameters: buildCodeTool.parameters as any,
      execute: async (args: unknown, context: any) => {
        const result = await buildCodeTool.execute(args as BuildCodeRequest, context);
        
        logIfTest(`TEST: ${result}`)

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
        context: z.array(z.string()).optional(),
        task_id: z.string().optional(),
        knowledge: z.array(z.string()).optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown, context?: { 
        log?: { info: (message: string, data?: any) => void; warn: (message: string, data?: any) => void; error: (message: string, data?: any) => void; debug: (message: string, data?: any) => void };
        streamContent?: (content: { type: string; text: string } | { type: string; text: string }[]) => Promise<void>;
        reportProgress?: (progress: { progress: number; total?: number }) => Promise<void>;
      }) => {
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
          // Use executeDisperslAgent for full agentic loop
          await this.executeDisperslAgent("/agent/tests", req, session, (message) => {
            context?.streamContent?.({
              type: "text",
              text: message + "\n"
            });
          });
          const toolName = "dispersl_testing_agent";
          const sessionTool = session.tools.get(toolName);
          
          // Compile all responses from the session
          const compiledResponse = this.compileSessionResponses(session, "dispersl_testing_agent");
          
          return {
            content: [
              {
                type: "text",
                text: compiledResponse || sessionTool?.lastResponse?.content || "Test generation completed"
              }
            ]
          };
        } catch (error) {
          context?.log?.error("Test generation failed", { error: error instanceof Error ? error.message : "Unknown error" });
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
              }
            ]
          };
        }
      }
    };
    this.server.addTool({
      name: buildTestsTool.name,
      description: buildTestsTool.description,
      parameters: buildTestsTool.parameters as any,
      execute: async (args: unknown, context: any) => {
        const result = await buildTestsTool.execute(args, context);
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
        context: z.array(z.string()).optional(),
        task_id: z.string().optional(),
        knowledge: z.array(z.string()).optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown, context?: { 
        log?: { info: (message: string, data?: any) => void; warn: (message: string, data?: any) => void; error: (message: string, data?: any) => void; debug: (message: string, data?: any) => void };
        streamContent?: (content: { type: string; text: string } | { type: string; text: string }[]) => Promise<void>;
        reportProgress?: (progress: { progress: number; total?: number }) => Promise<void>;
      }) => {
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
          // Use executeDisperslAgent for full agentic loop
          await this.executeDisperslAgent("/agent/git", req, session, (message) => {
            context?.streamContent?.({
              type: "text",
              text: message + "\n"
            });
          });
          const toolName = "dispersl_git_agent";
          const sessionTool = session.tools.get(toolName);
          
          // Compile all responses from the session
          const compiledResponse = this.compileSessionResponses(session, "dispersl_git_agent");
          
          return {
            content: [
              {
                type: "text",
                text: compiledResponse || sessionTool?.lastResponse?.content || "Git operations completed"
              }
            ]
          };
        } catch (error) {
          context?.log?.error("Git operations failed", { error: error instanceof Error ? error.message : "Unknown error" });
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
              }
            ]
          };
        }
      }
    };
    this.server.addTool({
      name: gitOperationTool.name,
      description: gitOperationTool.description,
      parameters: gitOperationTool.parameters as any,
      execute: async (args: unknown, context: any) => {
        const result = await gitOperationTool.execute(args, context);
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
        context: z.array(z.string()).optional(),
        task_id: z.string().optional(),
        knowledge: z.array(z.string()).optional(),
        mcp: z.record(z.unknown()).optional()
      }),
      execute: async (args: unknown, context?: { 
        log?: { info: (message: string, data?: any) => void; warn: (message: string, data?: any) => void; error: (message: string, data?: any) => void; debug: (message: string, data?: any) => void };
        streamContent?: (content: { type: string; text: string } | { type: string; text: string }[]) => Promise<void>;
        reportProgress?: (progress: { progress: number; total?: number }) => Promise<void>;
      }) => {
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
          // Use executeDisperslAgent for full agentic loop
          await this.executeDisperslAgent("/docs/repo", req, session, (message) => {
            context?.streamContent?.({
              type: "text",
              text: message + "\n"
            });
          });
          const toolName = "dispersl_new_docs_agent";
          const sessionTool = session.tools.get(toolName);
          
          // Compile all responses from the session
          const compiledResponse = this.compileSessionResponses(session, "dispersl_new_docs_agent");
          
          return {
            content: [
              {
                type: "text",
                text: compiledResponse || sessionTool?.lastResponse?.content || "Documentation generation completed"
              }
            ]
          };
        } catch (error) {
          context?.log?.error("Documentation generation failed", { error: error instanceof Error ? error.message : "Unknown error" });
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
              }
            ]
          };
        }
      }
    };
    this.server.addTool({
      name: generateDocsTool.name,
      description: generateDocsTool.description,
      parameters: generateDocsTool.parameters as any,
      execute: async (args: unknown, context: any) => {
        const result = await generateDocsTool.execute(args, context);
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
        context: z.array(z.string()).optional(),
        task_id: z.string().optional(),
        knowledge: z.array(z.string()).optional(),
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
          const stream = this.textStream("/agent/chat", req, session);
          let fullResponse = '';
          for await (const chunk of stream) {
            if (chunk.content) fullResponse += chunk.content;
          }
          return {
            content: [
              {
                type: "text",
                text: fullResponse                
              }
            ]
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`
              }
            ]
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
        session_id: z.string().optional()
      }),
      execute: async (args: unknown) => {
        const req = args as { session_id?: string };
        const sessionId = req.session_id || uuidv4();
        this.sessions.set(sessionId, {
          id: sessionId,
          tools: new Map(),
          context: {},
          conversation_history: [],
          active_tools: new Set()
        });
        return {
          type: "text",
          text: `Session ${sessionId} started`
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
            if (client.client && typeof (client.client as any).close === "function") {
              await (client.client as any).close();
            }
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

    // Model Management
    const listModelsTool: MCPTool = {
      name: "list_models",
      description: "List available models",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/models", "GET");
          logIfTest("[listModelsTool] API result:", result);
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          logIfTest("[listModelsTool] Error:", error);
          return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` }] };
        }
      }
    };
    this.server.addTool({
      name: listModelsTool.name,
      description: listModelsTool.description,
      parameters: listModelsTool.parameters as any,
      execute: async (args: unknown, _context: any) => {
        const result = await listModelsTool.execute(args);
        return {
          content: [{ text: (result as any).text, type: "text" }]
        };
      }
    });
    this.tools.set(listModelsTool.name, listModelsTool);    

    // API Keys
    const getKeysTool: MCPTool = {
      name: "get_keys",
      description: "Get API keys for the authenticated user",
      parameters: z.object({}),
      execute: async () => {
        try {
          const result = await this.callJsonEndpoint("/keys", "GET");
          logIfTest("get_keys API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_keys Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("new_key API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("new_key Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("create_task API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("create_task Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("edit_task API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("edit_task Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_tasks API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_tasks Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_task API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_task Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("cancel_task API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("cancel_task Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("edit_step API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("edit_step Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_steps API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_steps Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_step API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_step Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("cancel_step API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("cancel_step Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_usage_stats API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_usage_stats Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_language_stats API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_language_stats Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_agent_stats API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_agent_stats Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_task_history API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_task_history Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("get_step_history API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("get_step_history Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("fetch_api_root API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("fetch_api_root Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
          logIfTest("health_check API result:", result);
          return { content: [ { type: "text", text: JSON.stringify(result, null, 2) } ] };
        } catch (error) {
          logIfTest("health_check Error:", error);
          return { content: [ { type: "text", text: `Error: ${error instanceof Error ? error.message : "Unknown error"}` } ] };
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
        logIfTest(`Found MCP config at: ${path}\n`);
        return path;
      } catch (error) {
        // File doesn't exist, continue to next path
      }
    }

    // Default to local project .dispersl directory
    logIfTest(`No existing MCP config found, will create at: ${paths[0]}\n`);
    return paths[0];
  }

  private async loadMCPConfig(): Promise<void> {
    try {
      const configContent = await readFile(this.mcpConfigPath, "utf-8");
      this.mcpConfig = JSON.parse(configContent);
      logIfTest(`Loaded MCP config from: ${this.mcpConfigPath}\n`);
      if (this.mcpConfig && this.mcpConfig.mcpServers) {
        logIfTest(`Found ${Object.keys(this.mcpConfig.mcpServers).length} server(s) in config\n`);
      }
    } catch (error) {
      logIfTest(`No MCP config found at ${this.mcpConfigPath}, creating default config\n`);
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
        logIfTest(`Initializing ${serverEntries.length} MCP server connections...\n`);

        for (const [name, serverConfig] of serverEntries) {
          if ('type' in serverConfig && (serverConfig.type === 'streamable-http' || serverConfig.type === 'sse')) {
            // Skip HTTP/SSE configs for now
            continue;
          }
          try {
            await this.connectToMCPServer(serverConfig as MCPClientConfig, name);
            logIfTest(`✓ Connected to MCP server: ${name}\n`);
          } catch (error) {
            logIfTest(`✗ Failed to connect to MCP server ${name}:`, error);
          }
        }
      }
      // After all connections, update mcpTools
      this.updateMcpTools();
    } catch (error) {
      logIfTest("Error initializing MCP connections:", error);
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
          logIfTest(`[SSE][${name}] Error:`, err);
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
      version: "0.1.1"
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
        logIfTest(`Failed to execute tool ${toolName} on client ${clientName}:`, error);
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
          logIfTest('Failed to parse as JSON, returning cleaned text');
        }
      }

      return cleaned;
    } catch (error) {
      logIfTest('Error in cleanOutput:', error);
      return input;
    }
  }

  private async executeDisperslAgent(
    endpoint: string,
    args: BaseRequest & { prompt?: string; url?: string },
    session: AgenticSession,
    progressCallback?: (message: string, data?: any) => void
  ): Promise<void> {
    let currentEndpoint = endpoint;
    let currentArgs = { ...args, task_id: session.id };
    let iteration = 0;
    const maxIterations = 30; // Prevent infinite loops

    logIfTest(`Starting agentic execution loop for ${endpoint}`);

    while (iteration < maxIterations) {
      logIfTest(`Starting iteration ${iteration + 1}/${maxIterations}`);
      
      try {
        // Use up-to-date mcpTools
        const mcpTools = this.mcpTools;

        // Make streaming API call using ndjsonStream
        logIfTest(`Making API call to dispersl endpoint: ${currentEndpoint}`);
        const stream = this.ndjsonStream(currentEndpoint, {
          ...currentArgs,
          mcp: { tools: mcpTools }
        }, session);

        let fullResponse = '';
        const toolCalls: ToolCall[] = [];
        let hasContentChunks = false;
        let hasStructuredResponse = false;

        // Collect streaming response
        logIfTest("Starting to collect streaming response");
        
        for await (const chunk of stream) {
          if (chunk.content) {
            fullResponse += chunk.content;
            hasContentChunks = true;
            logIfTest(`[Stream] Content chunk: ${chunk.content}`);
          }
          if (chunk.tool_calls && Array.isArray(chunk.tool_calls)) {
            toolCalls.push(...chunk.tool_calls);
            hasStructuredResponse = true;
            logIfTest(`[Stream] Structured tool calls: ${JSON.stringify(chunk.tool_calls)}`);
          }
          if (chunk.tools && Array.isArray(chunk.tools)) {
            toolCalls.push(...chunk.tools);
            hasStructuredResponse = true;
            logIfTest(`[Stream] Tools array: ${JSON.stringify(chunk.tools)}`);
          }
          if (chunk.status === 'processing' && chunk.message && chunk.message !== 'Content chunk') {
            logIfTest(`[Stream] Processing: ${chunk.message}`);
          }
        }
        logIfTest(`Finished collecting streaming response - Content Length: ${fullResponse.length}, Tool Calls: ${toolCalls.length}`);

        // Parse text-based tool calls if no structured calls
        if (hasContentChunks && !hasStructuredResponse && fullResponse.includes('<｜tool▁call▁begin｜>')) {
          logIfTest(`[Stream] Parsing text-based tool calls from content`);
          progressCallback?.("Parsing text-based tool calls from content");
          progressCallback?.(`🔍 **Parsing text-based tool calls from content...**\n`);
          const parsedToolCalls = await this.parseTextToolCalls(fullResponse);
          if (parsedToolCalls.length > 0) {
            toolCalls.push(...parsedToolCalls);
            hasStructuredResponse = true;
            logIfTest(`[Stream] Parsed tool calls: ${JSON.stringify(parsedToolCalls)}`);
            progressCallback?.("Successfully parsed text-based tool calls");
            progressCallback?.(`✅ **Successfully parsed ${parsedToolCalls.length} tool call(s)**\n`);
          }
        }

        // Update session context and history
        // Note: ndjsonStream already updates session.conversation_history with the final response
        // The stream has already been consumed, so we don't need to await it again

        // Process tool calls
        progressCallback?.("Processing tool calls");
        progressCallback?.(`⚙️ **Processing ${toolCalls.length} tool call(s)...**\n`);
        const { responses: toolResponses, handover } = await this.processToolCalls(toolCalls, session);
        progressCallback?.("Tool calls processed");
        progressCallback?.(`✅ **Tool calls processed:** ${toolResponses.length} response(s), Handover: ${handover ? 'Yes' : 'No'}\n`);

        // Update session with tool responses
        const toolName = currentEndpoint.replace('/', '').replace('/', '_');
        progressCallback?.("Updating session with tool responses");
        session.tools.set(toolName, {
          name: toolName,
          description: `Tool for ${currentEndpoint}`,
          parameters: {},
          execute: async () => ({ content: fullResponse, tools: toolCalls }),
          lastResponse: { 
            content: fullResponse, 
            tools: toolCalls.map(toolCall => ({
              name: toolCall.function.name,
              arguments: JSON.parse(toolCall.function.arguments)
            }))
          }
        });

        // If no tool calls or session ended, break the loop
        if (toolResponses.length === 0 || toolResponses.some(r => r.tool === 'end_session')) {
          logIfTest(`[Loop] Breaking loop: No tool calls or session ended`);
          progressCallback?.("Breaking loop: No tool calls or session ended");
          progressCallback?.(`🛑 **Loop ending:** No tool calls or session ended\n\n`);
          break;
        }

        // If handover occurred, update endpoint and args for next iteration
        if (handover) {
          logIfTest(`[Loop] Handover to endpoint: ${handover.endpoint}`);
          progressCallback?.("Handover to different endpoint");
          progressCallback?.(`🔄 **Handover:** Switching from ${currentEndpoint} to ${handover.endpoint}\n\n`);
          currentEndpoint = handover.endpoint;
          currentArgs = {
            ...currentArgs,
            prompt: handover.prompt,
            ...handover.additionalArgs,
            task_id: session.id
          };
        } else {
          // Continue with same endpoint, include tool responses
          logIfTest(`[Loop] Continuing with same endpoint: ${currentEndpoint}`);
          progressCallback?.("Continuing with same endpoint");
          progressCallback?.(`🔄 **Continuing:** Same endpoint ${currentEndpoint} with ${toolResponses.length} tool response(s)\n\n`);
          currentArgs = {
            ...currentArgs,
            prompt: JSON.stringify({
              tool_responses: toolResponses,
              context: session.context
            })
          };
        }

        iteration++;
        progressCallback?.(`Completed iteration ${iteration}/${maxIterations}`);
        progressCallback?.(`✅ **Iteration ${iteration} completed**\n\n---\n\n`);
              } catch (error) {
          logIfTest(`[Loop] Error in executeDisperslAgent for ${currentEndpoint}:`, error);
          progressCallback?.(`Error in agentic execution loop: ${error instanceof Error ? error.message : "Unknown error"}`);
          progressCallback?.(`❌ **Error in iteration ${iteration}:** ${error instanceof Error ? error.message : "Unknown error"}\n\n`);
          session.conversation_history.push({
            role: "assistant",
            content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
            timestamp: new Date().toISOString()
          });
          break;
        }
      }

      if (iteration >= maxIterations) {
        logIfTest(`[Loop] Agentic loop reached maximum iterations (${maxIterations}) for ${currentEndpoint}`);
        progressCallback?.("Agentic loop reached maximum iterations");
        progressCallback?.(`⚠️ **Maximum iterations reached:** ${maxIterations} iterations completed\n\n`);
        session.conversation_history.push({
          role: "assistant",
          content: "Agentic loop reached maximum iterations",
          timestamp: new Date().toISOString()
        });
      }
      
      progressCallback?.("Agentic execution loop completed");
      
      // Stream final completion message
      progressCallback?.(`🎉 **Agentic execution completed!**\n- Total Iterations: ${iteration}\n- Endpoint: ${currentEndpoint}\n- Session ID: ${session.id}\n- Reached Max Iterations: ${iteration >= maxIterations ? 'Yes' : 'No'}\n\n`);
  }

  private compileSessionResponses(session: AgenticSession, toolName: string): string {
    const responses: string[] = [];
    
    // Add conversation history
    if (session.conversation_history.length > 0) {
      responses.push("## 📝 Conversation History\n");
      session.conversation_history.forEach((message, index) => {
        responses.push(`**${message.role.toUpperCase()} (${index + 1}):** ${message.content}\n`);
      });
      responses.push("\n");
    }
    
    // Add tool responses
    const sessionTool = session.tools.get(toolName);
    if (sessionTool?.lastResponse?.content) {
      responses.push("## 🎯 Final Response\n");
      if (typeof sessionTool.lastResponse.content === 'string') {
        responses.push(sessionTool.lastResponse.content);
      } else if (Array.isArray(sessionTool.lastResponse.content)) {
        sessionTool.lastResponse.content.forEach(content => {
          if (content.type === 'text' && 'text' in content) {
            responses.push(content.text);
          }
        });
      }
      responses.push("\n");
    }
    
    // Add tool calls if available
    if (sessionTool?.lastResponse?.tools && sessionTool.lastResponse.tools.length > 0) {
      responses.push("## 🔧 Tool Calls Executed\n");
      sessionTool.lastResponse.tools.forEach((tool, index) => {
        responses.push(`**${index + 1}. ${tool.name}**\n`);
        responses.push(`Arguments: ${JSON.stringify(tool.arguments, null, 2)}\n\n`);
      });
    }
    
    return responses.join("\n");
  }

  private async processToolCalls(
    toolCalls: ToolCall[],
    session: AgenticSession
  ): Promise<{ responses: ToolResponse[], handover?: HandoverInfo }> {
    const toolResponses: ToolResponse[] = [];
    let handover: HandoverInfo | undefined = undefined;

    for (const toolCall of toolCalls) {
      try {
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        logIfTest(`[processToolCalls] Executing tool: ${functionName} with args: ${JSON.stringify(functionArgs)}`);

        // Handle special control tools
        if (functionName === "end_session") {
          toolResponses.push({
            status: "SUCCESS",
            message: "Session ended",
            tool: functionName,
            output: ""
          });
          return { responses: toolResponses, handover };
        }

        // Handle handover to another agent
        if (functionName === "handover_task") {
          const handoverContent = functionArgs;
          const { agent_name, prompt, ...additionalArgs } = handoverContent;

          let endpoint = '';
          switch (agent_name) {
            case "code":
              endpoint = '/agent/code';
              break;
            case "test":
              endpoint = '/agent/tests';
              break;
            case "git":
              endpoint = '/agent/git';
              break;
            case "docs":
              endpoint = '/docs/repo';
              break;
            case "chat":
              endpoint = '/agent/chat';
              break;
            case "plan":
              endpoint = '/agent/plan';
              break;
            default:
              throw new Error(`Unknown agent for handover: ${agent_name}`);
          }

          handover = { endpoint, prompt, additionalArgs };
          toolResponses.push({
            status: "SUCCESS",
            message: `Task handed over to ${agent_name} at ${endpoint}`,
            tool: functionName,
            output: JSON.stringify({ endpoint, prompt, additionalArgs })
          });
          continue;
        }

        // Execute the tool
        const response = await this.executeMCPTool(functionName, functionArgs);

        // Handle different response types
        let cleanedOutput: string;
        if (response && typeof response === "object") {
          if ("type" in response && response.type === "data" && "data" in response) {
            cleanedOutput = JSON.stringify(response.data, null, 2);
          } else if ("type" in response && response.type === "text" && "text" in response) {
            cleanedOutput = this.cleanOutput(response.text || "");
          } else if ("content" in response) {
            cleanedOutput = this.cleanOutput(response.content || "");
          } else if ("output" in response) {
            cleanedOutput = this.cleanOutput(response.output || "");
          } else {
            cleanedOutput = this.cleanOutput(JSON.stringify(response));
          }
        } else {
          cleanedOutput = this.cleanOutput(response?.toString() || "");
        }

        toolResponses.push({
          status: "SUCCESS",
          message: "Operation completed successfully",
          tool: functionName,
          output: cleanedOutput
        });
        logIfTest(`[processToolCalls] Tool response for ${functionName}: ${cleanedOutput}`);

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        logIfTest(`[processToolCalls] Tool execution error for ${toolCall.function.name}: ${errorMessage}`);
        toolResponses.push({
          status: "FAILURE",
          message: `Error executing tool: ${errorMessage}`,
          tool: toolCall.function.name,
          output: ""
        });
      }
    }

    return { responses: toolResponses, handover };
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

  // Helper function to parse text-based tool calls
  public async parseTextToolCalls (text: string): Promise<any[]> {
    const parsed: any[] = [];

    // Split by tool call boundaries
    const toolCallPattern = /<｜tool▁call▁begin｜>/g;
    const toolCalls = text.split(toolCallPattern).slice(1); // Remove first empty element

    toolCalls.forEach((toolCall, index) => {
      try {
        // Extract function name
        const functionMatch = toolCall.match(/^function<｜tool▁sep｜>([^\n]+)/);
        if (!functionMatch) return;

        const functionName = functionMatch[1].trim();

        // Extract format (json/text/etc)
        const formatMatch = toolCall.match(/\n([a-z]+)\n/);
        const format = formatMatch ? formatMatch[1] : 'json';

        // Extract arguments - everything after the format line
        const argsStart = toolCall.indexOf('\n' + format + '\n') + format.length + 2;
        let argsText = toolCall.substring(argsStart).trim();

        // Clean up any trailing markers
        argsText = argsText.replace(/<｜[^｜]+｜>/g, '').trim();

        // Parse arguments based on format
        let parsedArgs = {};
        if (format === 'json') {
          try {
            parsedArgs = JSON.parse(argsText);
          } catch (e) {
            logIfTest(`Failed to parse JSON args: ${argsText}`);
            parsedArgs = { raw: argsText };
          }
        } else {
          parsedArgs = { raw: argsText };
        }

        // Create standardized tool call object
        const standardizedCall = {
          index: index,
          id: `call_${Date.now()}_${index}`, // Generate unique ID
          type: "function",
          function: {
            name: functionName,
            arguments: JSON.stringify(parsedArgs)
          }
        };

        parsed.push(standardizedCall);
        logIfTest(`Parsed tool call: ${functionName} with args: ${JSON.stringify(parsed)}`);

      } catch (error) {
        logIfTest(`Error parsing tool call: ${error}`);
      }
    });

    return parsed;
  }  

  public async start(port: number = 8080): Promise<void> {
    // Start as MCP server
    const transport = new StdioServerTransport();
    const server = new Server(
      {
        name: "dispersl-mcp",
        version: "0.1.1"
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
    logIfTest(`Dispersl MCP Server started and listening on stdio\n`);

    // Add this to ensure the process doesn't exit immediately
    if (process.stdin.isTTY) {
      logIfTest("Server is running. Press Ctrl+C to stop.\n");
    }
  }

  public async stop(): Promise<void> {
    // Close all MCP client connections
    for (const [name, client] of this.clients.entries()) {
      try {
        if (client.client && typeof (client.client as any).close === "function") {
          await (client.client as any).close();
        }
        logIfTest(`Closed connection to MCP client: ${name}\n`);
      } catch (error) {
        logIfTest(`Error closing MCP client ${name}:`, error);
      }
    }

    // Clear sessions
    this.sessions.clear();

    logIfTest("Dispersl MCP Server stopped\n");
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

  // Text Streaming Helper
  private async *textStream(endpoint: string, args: any, session?: AgenticSession, log?: any): AsyncGenerator<any, void, unknown> {
    logIfTest(`Calling NDJSON API endpoint: ${endpoint} ${JSON.stringify(args)}`);
    const response = await fetch(`${DISPERSL_API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(args)
    });
    if (!response.body) {
      logIfTest(`NDJSON API call failed: ${endpoint}. Error: No response body for NDJSON stream`);
      throw new Error("No response body for NDJSON stream");
    }
    logIfTest(`NDJSON API call response: ${response.body.toString()}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const done = false;
    let fullResponse = '';
    try {
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
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
      logIfTest(`NDJSON API call successful: ${response.body.toString()}`);
    } catch (error) {
      logIfTest(`NDJSON API call response failed: ${endpoint}. Error: ${error}`);
      throw error;
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

  // NDJSON Streaming Helper
  private async *ndjsonStream(endpoint: string, args: any, session?: AgenticSession, log?: any): AsyncGenerator<any, void, unknown> {
    logIfTest(`Calling NDJSON API endpoint: ${endpoint} ${JSON.stringify(args)}`);
    const response = await fetch(`${DISPERSL_API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(args)
    });
    if (!response.body) {
      logIfTest(`NDJSON API call failed: ${endpoint}. Error: No response body for NDJSON stream`);
      throw new Error("No response body for NDJSON stream");
    }
    logIfTest(`NDJSON API call response: ${response.body.toString()}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const done = false;
    let fullResponse = '';
    try {
      while (!done) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
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
      logIfTest(`NDJSON API call successful: ${response.body.toString()}`);
    } catch (error) {
      logIfTest(`NDJSON API call response failed: ${endpoint}. Error: ${error}`);
      throw error;
    }
    // Note: Session updates are now handled in executeDisperslAgent method
    // to properly manage conversation history across iterations
  }

  // Generic application/json endpoint helper
  private async callJsonEndpoint(endpoint: string, method: string = "GET", body?: any, log?: any): Promise<any> {
    logIfTest(`Calling API endpoint: ${endpoint} ${method} ${body}`);

    const response = await fetch(`${DISPERSL_API_BASE}${endpoint}`, {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      const text = await response.text();
      logIfTest(`API call failed: ${endpoint} ${method}. Error: ${text}`);
      throw new Error(`API call failed: ${response.status} ${response.statusText} - ${text}`);
    }
    const result = await response.json();
    logIfTest(`API call successful: ${endpoint} ${method} ${result}`);
    return result;
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
      logIfTest(`Warning: Content may not be a valid image. Detected MIME: ${mimeType?.mime || "unknown"}`);
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
      logIfTest(`Warning: Content may not be a valid audio file. Detected MIME: ${mimeType?.mime || "unknown"}`);
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
    logIfTest('Received SIGINT, shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logIfTest('Received SIGTERM, shutting down gracefully...');
    await server.stop();
    process.exit(0);
  });

  server.start().catch((error) => {
    logIfTest('Failed to start server:', error);
    process.exit(1);
  });
}
