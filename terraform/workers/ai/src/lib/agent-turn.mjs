// "One agent speaks" building block, shared by the single-agent tool-calling
// path (docs/specs/agent-tool-calling.md, formerly index.mjs's own
// runToolCallingLoop) and every team orchestration mode
// (docs/specs/agent-teams.md, "Agents mantêm suas próprias tools durante o
// turno" -- nested orchestration: a team turn's tool-calling loop has its own
// ceiling, independent of the team's rounds/max_orchestrator_steps ceiling).
// Kept in its own module (not index.mjs) so lib/team-orchestration.mjs can
// reuse it without depending on index.mjs, which only exports the
// WorkerEntrypoint class -- avoids a circular import between the two.
import { chatCompletion, chatCompletionWithTools } from "./ai.mjs";
import { TOOL_CATALOG, getToolDefinitions } from "./tools.mjs";
import { addMessage } from "./chat-db.mjs";

// docs/specs/agent-tool-calling.md: fallback used only when a caller doesn't
// resolve max_tool_iterations itself (mirrors index.mjs's own constant of the
// same name/value, kept in sync manually since both are small, private
// defaults -- not worth a shared constants module for one number).
const DEFAULT_MAX_TOOL_ITERATIONS = 5;

// Model -> tool -> model cycle (docs/specs/agent-tool-calling.md). Each round
// calls chatCompletionWithTools() -- which, unlike chatCompletion(), preserves
// the native "system"/"tool" roles Workers AI's function calling requires
// instead of running them through normalizeMessages(). `tools` is only ever
// passed while the iteration budget isn't exhausted (`cycle < maxIterations`):
// once it is, one last call is made *without* tools, forcing a text answer
// (spec step 4) -- its result is treated as final unconditionally, even if
// the model still tries to call a tool (unverified Workers AI behavior, see
// spec's "Casos a verificar"). Every intermediate assistant (tool-call
// request) and tool (result) message is persisted via addMessage() so the
// full exchange survives in chat_messages, same as the eventual final reply.
// Returns the exact message array that produced the final result too, so a
// streaming caller can replay the identical prompt with stream: true.
//
// docs/specs/agent-graph-tool.md: `actorSub`/`graphId` (the session's real
// user and the agent's graph_id) are resolved once here, into a single
// `context` object passed to every tool.execute() call in this loop -- not
// per tool call, and never from the model's own arguments. Tools that don't
// need it (query_knowledge_base) simply ignore it.
//
// `agentId` (docs/specs/agent-teams.md), when this loop is running as one
// member's turn inside a team orchestration, tags every persisted message
// with who produced it; defaults to null, which is exactly the previous
// (pre-teams) behavior for the single-agent path.
export async function runToolCallingLoop(
  env,
  sessionId,
  initialMessages,
  { model, temperature, max_tokens, top_p, toolNames, maxIterations, actorSub, graphId, agentId = null }
) {
  const toolDefinitions = getToolDefinitions(toolNames);
  const context = { actorSub, graphId };
  let messages = [...initialMessages];
  let cycle = 0;

  while (true) {
    const useTools = cycle < maxIterations;

    const result = await chatCompletionWithTools(env.AI, messages, {
      model,
      temperature,
      max_tokens,
      top_p,
      tools: useTools ? toolDefinitions : null,
    });

    if (!useTools || !result.toolCalls || result.toolCalls.length === 0) {
      return { result, messagesForFinalCall: messages };
    }

    await addMessage(env.CHAT_DB, {
      sessionId,
      role: "assistant",
      content: JSON.stringify({ tool_calls: result.toolCalls }),
      agentId,
    });
    messages = [...messages, { role: "assistant", content: result.content ?? "", tool_calls: result.toolCalls }];

    for (const toolCall of result.toolCalls) {
      const { name } = toolCall;
      const args = toolCall.arguments || {};
      const tool = TOOL_CATALOG[name];

      // A failing tool (unknown name, RPC error, missing binding) never
      // aborts the request -- it becomes an error result fed back to the
      // model as a normal tool message, and the loop continues.
      let toolResultContent;
      try {
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        toolResultContent = JSON.stringify(await tool.execute(env, args, context));
      } catch (error) {
        toolResultContent = JSON.stringify({ error: error.message });
      }

      await addMessage(env.CHAT_DB, { sessionId, role: "tool", content: toolResultContent, agentId });
      messages = [...messages, { role: "tool", name, content: toolResultContent }];
    }

    cycle += 1;
  }
}

// Maps a *live* agent row (agent-db.mjs's getAgentById shape -- snake_case)
// into the options object chatCompletion()/chatCompletionWithTools() expect.
// Mirrors index.mjs's buildAiOptions(), which does the same from a session's
// frozen agent_* snapshot instead -- kept separate rather than unified since
// the two shapes differ (snapshot columns vs. live agent fields) and unifying
// them would need an adapter either way.
export function buildAiOptionsFromAgent(agent) {
  const options = {};
  if (agent.model) options.model = agent.model;
  if (agent.temperature !== null && agent.temperature !== undefined) options.temperature = agent.temperature;
  if (agent.max_tokens !== null && agent.max_tokens !== undefined) options.max_tokens = agent.max_tokens;
  if (agent.top_p !== null && agent.top_p !== undefined) options.top_p = agent.top_p;
  return options;
}

// The message array a single turn sends to the model: the agent's own
// system_prompt (if any) prepended ahead of one user-role message carrying
// `turnContent`. Always exactly one user message, never a multi-message
// history threaded across turns -- see runAgentTurn's comment for why.
// Exported so lib/team-orchestration.mjs can reconstruct the equivalent
// message array without an extra model call (moderator early-finish replay).
export function buildTurnMessages(agent, turnContent) {
  const base = [{ role: "user", content: turnContent }];
  return agent.system_prompt ? [{ role: "system", content: agent.system_prompt }, ...base] : base;
}

// One member's turn inside a team orchestration (any of the 3 modes,
// docs/specs/agent-teams.md), and also reusable for a single-agent turn in
// general: runs the agent's own tool-calling loop when it has `tools`
// configured (nested orchestration -- the team's round/step ceiling is
// independent from the agent's own max_tool_iterations ceiling), or a single
// chatCompletion() call otherwise.
//
// `turnContent` is deliberately always one plain string, turned into exactly
// one user-role message (plus the agent's own system prompt, if any) -- never
// a multi-message conversation history threaded across turns. Team
// orchestration modes are responsible for flattening whatever context they
// need (transcript so far, previous pipeline output, etc.) into that single
// string. This sidesteps Workers AI's strict user/assistant role-alternation
// requirement (ADR 0009) entirely at the team level: only the tool-calling
// loop itself builds a (still-compliant, short) alternating sequence within a
// single turn, exactly like the pre-existing single-agent tool-calling path.
//
// Always persists the turn's final content via addMessage(..., { agentId })
// so the full inter-agent transcript survives in chat_messages
// (docs/specs/agent-teams.md, "Usuário vê só a resposta final; transcript
// completo fica persistido").
export async function runAgentTurn(env, sessionId, agent, turnContent, { actorSub }) {
  const aiOptions = buildAiOptionsFromAgent(agent);
  const messages = buildTurnMessages(agent, turnContent);

  const toolNames = agent.tools;
  let content;
  let usage;
  let messagesForFinalCall;

  if (Array.isArray(toolNames) && toolNames.length > 0) {
    const { result, messagesForFinalCall: loopMessages } = await runToolCallingLoop(env, sessionId, messages, {
      ...aiOptions,
      toolNames,
      maxIterations: agent.max_tool_iterations ?? DEFAULT_MAX_TOOL_ITERATIONS,
      actorSub,
      graphId: agent.graph_id,
      agentId: agent.id,
    });
    content = result.content;
    usage = result.usage;
    messagesForFinalCall = loopMessages;
  } else {
    const result = await chatCompletion(env.AI, messages, aiOptions);
    content = result.choices[0].message.content;
    usage = result.usage;
    messagesForFinalCall = messages;
  }

  await addMessage(env.CHAT_DB, { sessionId, role: "assistant", content, agentId: agent.id });

  return { content, usage, messagesForFinalCall, aiOptions };
}
