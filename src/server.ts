import { FastMCP } from "fastmcp";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  MCPToolCallRequest
} from "./types";

const execAsync = async (command: string, args?: string[]) => {
  const { stdout, stderr } = await execa(command, args);
  return { stdout, stderr };
};

// API Configuration
const DISPERSL_API_BASE = "https://api.dispersl.com/v1";
const DISPERSL_API_KEY = process.env.DISPERSL_API_KEY;

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

// Helper function to make API calls
async function callDisperslAPI(endpoint: string, method: string, body?: unknown): Promise<any> {
  if (!DISPERSL_API_KEY) {
    throw new Error("DISPERSL_API_KEY environment variable is required");
  }

  const response = await fetch(`${DISPERSL_API_BASE}${endpoint}`, {
    method,
    headers: {
      "Authorization": `Bearer ${DISPERSL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    throw new Error(`API call failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
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

  constructor() {
    this.server = new FastMCP({
      name: "dispersl-mcp",
      version: "0.1.0",
      instructions: "I am an MCP server that can act as both a server and client. I can connect to other MCP servers and execute their tools in agentic loops."
    });

    this.clients = new Map();
    this.sessions = new Map();
    this.mcpConfigPath = join(process.cwd(), ".dispersl", "mcp.json");

    this.setupTools();
    this.loadMCPConfig();
  }

  private setupTools() {
    // Model Management
    this.server.addTool({
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
    });

    // Code Generation
    this.server.addTool({
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
      execute: async (args: BuildCodeRequest) => {
        const sessionId = args.conversation_id || `session_${Date.now()}`;

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
          await this.executeDisperslAgent("/build/code", args, session);

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
    });

    // Test Generation
    this.server.addTool({
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
      execute: async (args: BuildTestsRequest) => {
        const sessionId = args.conversation_id || `session_${Date.now()}`;

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
          await this.executeDisperslAgent("/build/tests", args, session);

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
    });

    // Git Operations
    this.server.addTool({
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
      execute: async (args: GitOperationRequest) => {
        const sessionId = args.conversation_id || `session_${Date.now()}`;

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
          await this.executeDisperslAgent("/build/git", args, session);

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
    });

    // Documentation Generation
    this.server.addTool({
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
      execute: async (args: GenerateDocsRequest) => {
        const sessionId = args.conversation_id || `session_${Date.now()}`;

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
          await this.executeDisperslAgent("/docs/repo", args, session);

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
    });

    // Chat
    this.server.addTool({
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
      execute: async (args: ChatRequest) => {
        const sessionId = args.conversation_id || `session_${Date.now()}`;

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
            content: args.prompt,
            timestamp: new Date().toISOString()
          });

          const stream = await this.executeDisperslStream("/chat", args, session);
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
    });

    // Session Management
    this.server.addTool({
      name: "start_session",
      description: "Start a new agentic session",
      parameters: z.object({
        session_id: z.string()
      }),
      execute: async (args: { session_id: string }) => {
        this.sessions.set(args.session_id, {
          id: args.session_id,
          tools: new Map(),
          context: {},
          conversation_history: [],
          active_tools: new Set()
        });

        return {
          type: "text",
          text: `Session ${args.session_id} started`
        };
      }
    });

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
    this.server.addTool({
      name: "add_mcp_server",
      description: "Connect to an external MCP server",
      parameters: z.object({
        name: z.string(),
        command: z.string(),
        args: z.array(z.string()),
        env: z.record(z.string()).optional()
      }),
      execute: async (args: MCPClientConfig) => {
        try {
          await this.connectToMCPServer(args);
          return {
            type: "text",
            text: `Connected to MCP server: ${args.name}`
          };
        } catch (error) {
          return {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Failed to connect"}`
          };
        }
      }
    });

    this.server.addTool({
      name: "list_mcp_clients",
      description: "List all connected MCP clients",
      parameters: z.object({}),
      execute: async () => {
        const clients = Array.from(this.clients.keys());
        return {
          type: "text",
          text: JSON.stringify({ status: "success", clients })
        };
      }
    });
  }

  private async loadMCPConfig(): Promise<void> {
    try {
      const configContent = await readFile(this.mcpConfigPath, "utf-8");
      this.mcpConfig = JSON.parse(configContent);
    } catch (error) {
      // If config doesn't exist, create default
      this.mcpConfig = {
        servers: []
      };
      await this.saveMCPConfig();
    }
  }

  private async saveMCPConfig(): Promise<void> {
    const configDir = dirname(this.mcpConfigPath);
    await mkdir(configDir, { recursive: true });
    await writeFile(this.mcpConfigPath, JSON.stringify(this.mcpConfig, null, 2));
  }

  private async connectToMCPServer(config: MCPClientConfig): Promise<void> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env
    });

    const client = new Client({
      name: config.name,
      version: "0.1.0"
    }, {
      capabilities: {}
    });

    await client.connect(transport);

    // Get available tools
    const toolsResult = await client.request(
      { method: "tools/list", params: {} }
    );

    const tools = new Map<string, MCPTool>();
    if (toolsResult && 'tools' in toolsResult && Array.isArray(toolsResult.tools)) {
      for (const tool of toolsResult.tools) {
        tools.set(tool.name, {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          execute: async (args: unknown) => {
            const result = await client.request(
              {
                method: "tools/call",
                params: {
                  name: tool.name,
                  arguments: args
                }
              }
            );
            return result;
          }
        });
      }
    }

    this.clients.set(config.name, {
      name: config.name,
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
      const response = await callDisperslAPI(endpoint, "POST", {
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
      const response = await callDisperslAPI(endpoint, "POST", {
        ...args,
        conversation_id: session.id,
        mcp: {
          tools: mcpTools
        }
      });

      // Update session context
      session.context = { ...session.context, ...response.context };

      // Create an async generator to stream the response
      const self = this;
      async function* streamResponse() {
        let fullResponse = '';

        if (response.content) {
          if (typeof response.content === 'string') {
            yield response.content;
            fullResponse += response.content;
          } else if (Array.isArray(response.content)) {
            for (const content of response.content) {
              if (typeof content === 'string') {
                yield content;
                fullResponse += content;
              } else if ('text' in content) {
                yield content.text;
                fullResponse += content.text;
              } else if (content.type === 'multipart') {
                const processedResponse = await processMultipartResponse(content, {
                  onTextContent: (text) => {
                    fullResponse += text;
                  },
                  onKnowledgeRetrieved: async (knowledge) => {
                    // Handle knowledge retrieval if needed
                    console.log('Knowledge retrieved:', knowledge);
                  },
                  onToolCall: async (toolData) => {
                    // Process tool calls
                    if (response.tools && Array.isArray(response.tools)) {
                      const toolResponses = await self.processToolCalls(response.tools, session);
                      for (const toolResponse of toolResponses) {
                        fullResponse += toolResponse.output;
                      }
                    }
                  },
                  onStreamUpdate: (updatedResponse) => {
                    fullResponse = updatedResponse;
                  }
                });
                yield processedResponse;
              }
            }
          }
        }

        // If response includes tools to execute, process them
        if (response.tools && Array.isArray(response.tools)) {
          const toolResponses = await self.processToolCalls(response.tools, session);
          for (const toolResponse of toolResponses) {
            yield toolResponse.output;
            fullResponse += toolResponse.output;
          }
        }

        // Update session with final response
        const toolName = endpoint.replace('/', '').replace('/', '_');
        session.tools.set(toolName, {
          name: toolName,
          description: `Tool for ${endpoint}`,
          parameters: {},
          execute: async () => response,
          lastResponse: {
            content: fullResponse,
            context: response.context,
            tools: response.tools
          }
        });

        // Add to conversation history
        session.conversation_history.push({
          role: "assistant",
          content: fullResponse || "Operation completed",
          timestamp: new Date().toISOString()
        });
      }

      return streamResponse();
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

          response = await callDisperslAPI(endpoint, "POST", {
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
        const response = await callDisperslAPI("/chat", "POST", {
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
        name: "dispersl-mcp-server",
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
      const tools = Array.from(this.server.tools.keys()).map(name => {
        const tool = this.server.tools.get(name);
        return {
          name,
          description: tool?.description || "",
          inputSchema: tool?.parameters || {}
        };
      });

      return { tools };
    });

    server.setRequestHandler(z.object({
      method: z.literal("tools/call")
    }), async (request: MCPToolCallRequest) => {
      const { name, arguments: args } = request.params;
      const tool = this.server.tools.get(name);
      if (!tool) {
        throw new Error(`Tool ${name} not found`);
      }
      return tool.execute(args);
    });

    await server.connect(transport);
    console.log(`Dispersl MCP Server started and listening on stdio`);

    // Also start FastMCP server for HTTP interface if needed
    try {
      await this.server.start({
        transportType: "httpStream",
        httpStream: {
          port
        }
      });
      console.log(`HTTP interface available on port ${port}`);
    } catch (error) {
      console.log("HTTP interface not started (this is normal for MCP servers)");
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

    // Stop FastMCP server
    try {
      await this.server.stop();
    } catch (error) {
      console.debug("FastMCP server stop error (expected for stdio mode)");
    }

    console.log("Dispersl MCP Server stopped");
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

// Run the server if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new DisperslMCPServer();

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