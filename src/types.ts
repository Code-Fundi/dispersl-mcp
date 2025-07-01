import { z } from "zod";

// Base interfaces
export interface BaseRequest {
  model?: string;
  context?: string;
  task_id?: string;
  knowledge?: string;
  os?: string;
  default_dir?: string;
  current_dir?: string;
  mcp?: Record<string, unknown>;
}

export interface BaseResponse {
  status: "success" | "error";
  error?: string;
}

// Model Management
export interface Model {
  id: string;
  name: string;
  description: string;
  context_length: number;
  tier_requirements: {
    free_model: boolean;
  };
}

export interface ModelsResponse {
  status: "success" | "error";
  models: Model[];
  error?: string;
}

// Code Generation & Development
export interface BuildCodeRequest extends BaseRequest {
  prompt: string;
}

export interface BuildCodeResponse {
  status: "success" | "error";
  content: string;
  error?: string;
}

// Testing
export interface BuildTestsRequest extends BaseRequest {
  prompt: string;
}

export interface BuildTestsResponse {
  status: "success" | "error";
  content: string;
  error?: string;
}

// Git Operations
export interface GitOperationRequest extends BaseRequest {
  prompt: string;
}

export interface GitOperationResponse {
  status: "success" | "error";
  content: string;
  error?: string;
}

// Documentation
export interface GenerateDocsRequest extends BaseRequest {
  url: string;
  branch?: string;
  team_access?: boolean;
}

export interface GenerateDocsResponse {
  status: "success" | "error";
  content: string;
  error?: string;
}

export interface BuildDocsRequest extends BaseRequest {
  url: string;
  branch?: string;
  team_access?: boolean;
}

// Chat & Conversation
export interface ChatRequest extends BaseRequest {
  prompt: string;
  memory?: boolean;
  voice?: boolean;
}

export interface ChatResponse {
  status: "success" | "error";
  content: Array<{
    type: string;
    text: string;
  }>;
  tools?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  error?: string;
}

// API Key Management
export interface Token {
  name: string;
  publicKey: string;
  created_at: string;
}

export interface GenerateTokenRequest {
  name: string;
  user_id: string;
}

export interface GenerateTokenResponse {
  status: "success" | "error";
  publicKey: string;
  message: string;
  error?: string;
}

export interface ListTokensResponse {
  status: "success" | "error";
  apiKeys: Token[];
  error?: string;
}

// Conversation Management
export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  last_message: string;
}

export interface ConversationDetail extends Conversation {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }>;
}

export interface ListConversationsResponse {
  status: "success" | "error";
  conversations: Conversation[];
  error?: string;
}

export interface GetConversationResponse {
  status: "success" | "error";
  conversation?: ConversationDetail;
  error?: string;
}

// MCP Tool Types
export interface MCPTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (args: unknown) => Promise<unknown>;
  lastResponse?: {
    content?: string | Content[];
    error?: string;
    context?: Record<string, unknown>;
    tools?: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
  };
}

export interface MCPToolContext {
  streamContent?: (content: { type: string; text: string }) => Promise<void>;
}

export interface MCPToolCallRequest {
  params: {
    name: string;
    arguments: unknown;
  };
}

// Agentic Session Types
export interface AgenticSession {
  id: string;
  tools: Map<string, MCPTool>;
  context: Record<string, unknown>;
  conversation_history: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }>;
  active_tools: Set<string>;
}

// MCP Client Types
export interface MCPClientConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MCPClient {
  name: string;
  client: any; // Replace with actual client type
  tools: Map<string, MCPTool>;
  executeTool: (toolName: string, args: unknown) => Promise<unknown>;
}

// MCP Server Configuration
export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  tools?: string[];
}

export type MCPHttpConfig =
  | {
      type: 'streamable-http';
      url: string;
      env?: Record<string, string>;
      note?: string;
    }
  | {
      type: 'sse';
      url: string;
      env?: Record<string, string>;
      note?: string;
    };

export interface MCPConfig {
  mcpServers: Record<string, MCPClientConfig | MCPHttpConfig>;
}

// Error Classes
export class DisperslMCPError extends Error {
  public constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UserError extends DisperslMCPError { }

// Content Types
export type TextContent = {
  text: string;
  type: "text";
};

export type ImageContent = {
  data: string;
  mimeType: string;
  type: "image";
};

export type AudioContent = {
  data: string;
  mimeType: string;
  type: "audio";
};

export type ResourceContent = {
  resource: {
    blob?: string;
    mimeType?: string;
    text?: string;
    uri: string;
  };
  type: "resource";
};

export type Content = AudioContent | ImageContent | ResourceContent | TextContent;

// Multipart Response Types
export interface MultipartResponseOptions {
  onTextContent?: (text: string) => void;
  onKnowledgeRetrieved?: (knowledge: string) => Promise<void>;
  onToolCall?: (toolData: Record<string, unknown>) => Promise<void>;
  onStreamUpdate?: (fullResponse: string) => void;
}

export interface MultipartResponse {
  type: string;
  content?: string;
  knowledge?: string;
  tool?: {
    name: string;
    arguments: Record<string, unknown>;
  };
} 