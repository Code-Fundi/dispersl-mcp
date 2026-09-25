import { describe, expect, it } from "vitest";
import {
  buildSystemOnePrompt,
  formatSessionTools,
  handoverTarget,
  isSystemOneModel,
  normalizeIncomingTool,
  prepareDisperslRequestBody,
  resolveSystemOnePrompt,
} from "./systemOne.js";

describe("system-one mcp helpers", () => {
  it("detects typesafe models", () => {
    expect(isSystemOneModel("typesafe/jev-1.13")).toBe(true);
    expect(isSystemOneModel("~typesafe/jev-latest")).toBe(true);
    expect(isSystemOneModel("stealth/ox-alpha")).toBe(false);
  });

  it("wraps prose prompts for system-one completions", () => {
    const wrapped = resolveSystemOnePrompt("typesafe/jev-1.13", "research the book");
    expect(wrapped).toEqual(buildSystemOnePrompt("research the book"));
  });

  it("keeps an already valid system-one object", () => {
    const prompt = {
      state: "ready",
      questions: { ACTION: { type: "choice", instructions: "Pick", criteria: { HOLD: "hold" } } },
    };
    expect(resolveSystemOnePrompt("typesafe/jev-1.13", prompt)).toEqual(prompt);
  });

  it("does not wrap language prompts", () => {
    expect(resolveSystemOnePrompt("stealth/ox-alpha", "write tests")).toBe("write tests");
  });

  it("sends custom agents to /agent/completion and strips jev from plan", () => {
    const completion = prepareDisperslRequestBody(
      "/agent",
      { prompt: "decide", model: "typesafe/jev-1.13", name_id: "voter" },
      "stealth/ox-alpha"
    );
    expect(completion.endpoint).toBe("/agent/completion");
    expect(completion.body.prompt).toEqual(buildSystemOnePrompt("decide"));

    const plan = prepareDisperslRequestBody(
      "/agent/plan",
      { prompt: "plan it", model: "typesafe/jev-1.13" },
      "stealth/ox-alpha"
    );
    expect(plan.endpoint).toBe("/agent/plan");
    expect(plan.body.model).toBe("stealth/ox-alpha");
    expect(plan.body.prompt).toBe("plan it");
  });

  it("hands unknown agents to custom completion with name_id", () => {
    expect(handoverTarget("code")).toEqual({ endpoint: "/agent/code", additionalArgs: {} });
    expect(handoverTarget("system-one-smoke-c7rr")).toEqual({
      endpoint: "/agent/completion",
      additionalArgs: { name_id: "system-one-smoke-c7rr" },
    });
  });

  it("normalizes native handover_task tools", () => {
    const tool = normalizeIncomingTool({
      type: "handover_task",
      agent_name: "specialist-b",
      prompt: "next hop",
    });
    expect(tool.function.name).toBe("handover_task");
    expect(JSON.parse(tool.function.arguments)).toEqual({
      agent_name: "specialist-b",
      prompt: "next hop",
    });
    expect(formatSessionTools([tool])).toEqual([
      { name: "handover_task", arguments: { agent_name: "specialist-b", prompt: "next hop" } },
    ]);
  });
});
