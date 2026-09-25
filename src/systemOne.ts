export type SystemOneQuestionType = "choice" | "noul" | "score";

export interface SystemOneQuestion {
  type: SystemOneQuestionType;
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface SystemOnePrompt {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, SystemOneQuestion>;
}

export function isSystemOneModel(modelId?: string | null): boolean {
  if (!modelId) {
    return false;
  }
  return modelId.startsWith("typesafe/") || modelId.startsWith("~typesafe/");
}

export function isSystemOnePrompt(value: unknown): value is SystemOnePrompt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return "state" in record && "questions" in record && typeof record.questions === "object" && record.questions !== null;
}

export function buildSystemOnePrompt(stateText: string): SystemOnePrompt {
  return {
    state: stateText,
    questions: {
      NEXT: {
        type: "choice",
        instructions: "Choose the next action for this agent.",
        criteria: {
          CONTINUE: "Continue working",
          DONE: "The task is complete",
        },
      },
    },
  };
}

export function resolveSystemOnePrompt(model: string | undefined, prompt: unknown): unknown {
  if (!isSystemOneModel(model)) {
    return prompt;
  }
  if (isSystemOnePrompt(prompt)) {
    return prompt;
  }
  if (typeof prompt === "string") {
    const trimmed = prompt.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isSystemOnePrompt(parsed)) {
          return parsed;
        }
      } catch {
        // Fall through to wrap the original string as state.
      }
    }
    return buildSystemOnePrompt(prompt);
  }
  if (prompt == null) {
    return buildSystemOnePrompt("");
  }
  return buildSystemOnePrompt(JSON.stringify(prompt));
}

export function isPlanEndpoint(endpoint: string): boolean {
  return endpoint === "/agent/plan";
}

export function isCustomAgentEndpoint(endpoint: string): boolean {
  return endpoint === "/agent/completion" || endpoint === "/agent";
}

export function normalizeCustomAgentEndpoint(endpoint: string): string {
  return endpoint === "/agent" ? "/agent/completion" : endpoint;
}

export function handoverTarget(agentName: string): { endpoint: string; additionalArgs: Record<string, unknown> } {
  switch (agentName) {
    case "code":
      return { endpoint: "/agent/code", additionalArgs: {} };
    case "test":
      return { endpoint: "/agent/tests", additionalArgs: {} };
    case "git":
      return { endpoint: "/agent/git", additionalArgs: {} };
    case "docs":
      return { endpoint: "/docs/repo", additionalArgs: {} };
    case "chat":
      return { endpoint: "/agent/chat", additionalArgs: {} };
    case "plan":
      return { endpoint: "/agent/plan", additionalArgs: {} };
    default:
      return { endpoint: "/agent/completion", additionalArgs: { name_id: agentName } };
  }
}

export function prepareDisperslRequestBody(
  endpoint: string,
  args: Record<string, unknown>,
  planFallbackModel?: string | null
): { endpoint: string; body: Record<string, unknown> } {
  const resolvedEndpoint = normalizeCustomAgentEndpoint(endpoint);
  const body = { ...args };

  if (isPlanEndpoint(resolvedEndpoint) && isSystemOneModel(typeof body.model === "string" ? body.model : undefined)) {
    if (planFallbackModel) {
      body.model = planFallbackModel;
    } else {
      delete body.model;
    }
  }

  if (isCustomAgentEndpoint(resolvedEndpoint)) {
    body.prompt = resolveSystemOnePrompt(
      typeof body.model === "string" ? body.model : undefined,
      body.prompt
    );
  }

  return { endpoint: resolvedEndpoint, body };
}

export function formatSessionTools(toolCalls: Array<Record<string, unknown>>): Array<{ name: string; arguments: Record<string, unknown> }> {
  return toolCalls.map((toolCall) => {
    const fn = toolCall.function as { name?: string; arguments?: string } | undefined;
    if (fn?.name) {
      let parsed: unknown = {};
      try {
        parsed = fn.arguments ? JSON.parse(fn.arguments) : {};
      } catch {
        parsed = { raw: fn.arguments ?? "" };
      }
      const args = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : { value: parsed };
      return { name: fn.name, arguments: args };
    }
    const name = String(toolCall.type ?? toolCall.name ?? "unknown");
    return { name, arguments: toolCall };
  });
}

export function normalizeIncomingTool(raw: unknown): { function: { name: string; arguments: string } } {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const fn = typeof record.function === "object" && record.function !== null
    ? (record.function as Record<string, unknown>)
    : {};

  if (typeof fn.name === "string") {
    return {
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    };
  }

  if (record.type === "handover_task" || typeof record.agent_name === "string") {
    return {
      function: {
        name: "handover_task",
        arguments: JSON.stringify({
          agent_name: record.agent_name,
          prompt: record.prompt,
        }),
      },
    };
  }

  const name = typeof record.name === "string" ? record.name : "unknown";
  return {
    function: {
      name,
      arguments: typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments ?? {}),
    },
  };
}
