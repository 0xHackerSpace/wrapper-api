// Multi-agent orchestration engine (docs/specs/agent-teams.md): the 3
// orchestration modes a team can declare (pipeline, debate, orchestrator).
// Kept separate from index.mjs so it can import lib/agent-turn.mjs directly
// without a circular dependency (index.mjs isn't importable -- it only
// exports the WorkerEntrypoint class).
//
// Every team/member lookup here is *live* (getTeamById/getAgentById queried
// fresh, never cached) -- docs/specs/agent-teams.md's "referência viva":
// editing a team mid-conversation changes the very next message's behavior,
// a deliberate trade-off the spec accepts (see "Consequência aceita").
//
// Design decision (not spelled out in the spec): every turn's input is
// flattened into a single user-role string (built by the small
// build*TurnContent() helpers below), never a multi-message conversation
// history threaded across turns/rounds. This sidesteps Workers AI's strict
// user/assistant role-alternation requirement (ADR 0009) -- a transcript with
// one assistant-role message per speaker, with no interleaved user turns,
// would violate that alternation. See lib/agent-turn.mjs's runAgentTurn for
// the same reasoning applied to a single turn.
import { getTeamById } from "./team-db.mjs";
import { getAgentById } from "./agent-db.mjs";
import { runAgentTurn, buildAiOptionsFromAgent, buildTurnMessages } from "./agent-turn.mjs";
import { chatCompletionWithTools } from "./ai.mjs";
import { addMessage } from "./chat-db.mjs";

const DEFAULT_MAX_ORCHESTRATOR_STEPS = 10;

async function loadMembers(env, team) {
  const members = [];
  for (const m of team.members) {
    const agent = await getAgentById(env.AGENTS_DB, m.agent_id);
    if (!agent) {
      // Real infra failure (a live reference pointing at a since-deleted
      // agent, which the schema's FK should normally prevent) -- aborts the
      // whole orchestration, same "no sensible recovery" rule as any other
      // model/infra failure mid-orchestration (docs/specs/agent-teams.md).
      throw new Error(`Team member agent not found: ${m.agent_id}`);
    }
    members.push(agent);
  }
  return members;
}

function formatTranscript(transcript) {
  return transcript.map((t) => `[${t.agentName}]: ${t.content}`).join("\n");
}

// --- pipeline ---

function buildPipelineTurnContent(userContent, previousOutput) {
  if (previousOutput === null) {
    return userContent;
  }
  return `Mensagem original do usuário: ${userContent}\n\nSaída do agente anterior na cadeia:\n${previousOutput}\n\nContinue a partir daqui, considerando a mensagem original e a saída do agente anterior.`;
}

// docs/specs/agent-teams.md, "pipeline": each member gets only the previous
// member's output plus the original user message as fixed context (not the
// full chain); the last member's output is the final answer.
async function runPipeline(env, sessionId, members, userContent, actorSub) {
  let previousOutput = null;
  let turn = null;

  for (const agent of members) {
    const turnContent = buildPipelineTurnContent(userContent, previousOutput);
    turn = await runAgentTurn(env, sessionId, agent, turnContent, { actorSub });
    previousOutput = turn.content;
  }

  return turn;
}

// --- debate ---

function buildDebateTurnContent(userContent, transcript) {
  const discussion = transcript.length > 0 ? `\n\nDiscussão até agora:\n${formatTranscript(transcript)}` : "";
  return `Pergunta original do usuário: ${userContent}${discussion}\n\nAgora é sua vez de contribuir para a discussão.`;
}

const MODERATOR_TAG_FINAL = "[FINAL]";
const MODERATOR_TAG_CONTINUE = "[CONTINUE]";

// The moderator's decision is signaled via a simple text-prefix protocol
// (judgment call, spec leaves this open: "use seu julgamento de como
// sinalizar essa decisão de forma parseável") rather than function calling --
// function calling in orchestration mode is explicitly what the spec asks
// for, but for the moderator's stop/continue decision it deliberately says
// this isn't required. A plain, easy-to-parse text tag keeps the moderator
// call a normal chatCompletion()-shaped turn, reusable via runAgentTurn like
// every other debate turn (including one with its own tools configured).
function buildModeratorTurnContent(userContent, transcript, { forceFinish }) {
  const discussion = `\n\nDiscussão até agora:\n${formatTranscript(transcript)}`;
  if (forceFinish) {
    return `Pergunta original do usuário: ${userContent}${discussion}\n\nO limite de rodadas foi atingido. Com base em toda a discussão acima, produza agora a resposta final ao usuário original.`;
  }
  return (
    `Pergunta original do usuário: ${userContent}${discussion}` +
    `\n\nComo moderador, decida: se a discussão já é suficiente para responder ao usuário, comece sua resposta com a tag ${MODERATOR_TAG_FINAL} seguida imediatamente da resposta final ao usuário. ` +
    `Caso contrário, comece sua resposta com a tag ${MODERATOR_TAG_CONTINUE} seguida de uma breve orientação para a próxima rodada.`
  );
}

function parseModeratorDecision(content) {
  const trimmed = (content || "").trim();
  if (trimmed.toUpperCase().startsWith(MODERATOR_TAG_FINAL)) {
    return { finish: true, finalAnswer: trimmed.slice(MODERATOR_TAG_FINAL.length).trim() };
  }
  // Anything else (including the expected [CONTINUE] tag, or a model that
  // didn't comply with the protocol at all) means "keep discussing" -- the
  // `rounds` ceiling checked by the caller still guarantees termination
  // even in the adversarial case of a moderator that never says [FINAL].
  return { finish: false };
}

function buildSynthesisTurnContent(userContent, transcript) {
  return `Pergunta original do usuário: ${userContent}\n\nDiscussão completa:\n${formatTranscript(transcript)}\n\nCom base em toda a discussão acima, produza a resposta final ao usuário original.`;
}

// docs/specs/agent-teams.md, "debate": all members see the original user
// message and the discussion so far, speaking in order_index order each
// round. `fixed_rounds` always runs exactly `rounds` rounds, then the
// lead_agent_id synthesizes a final answer. `moderator` asks the lead agent
// after every round whether to stop; `rounds` is always the hard ceiling
// regardless of the moderator's own decision (so an adversarial moderator
// that never says [FINAL] still terminates).
async function runDebate(env, sessionId, team, members, userContent, actorSub) {
  const transcript = [];
  const maxRounds = team.rounds;
  const leadAgent = members.find((a) => a.id === team.lead_agent_id);

  for (let round = 1; round <= maxRounds; round += 1) {
    for (const agent of members) {
      const turnContent = buildDebateTurnContent(userContent, transcript);
      const turn = await runAgentTurn(env, sessionId, agent, turnContent, { actorSub });
      transcript.push({ agentName: agent.name, content: turn.content });
    }

    if (team.termination_strategy !== "moderator") {
      continue;
    }

    const isLastRound = round >= maxRounds;
    const moderatorContent = buildModeratorTurnContent(userContent, transcript, { forceFinish: isLastRound });
    const moderatorTurn = await runAgentTurn(env, sessionId, leadAgent, moderatorContent, { actorSub });

    if (isLastRound) {
      return moderatorTurn;
    }

    const decision = parseModeratorDecision(moderatorTurn.content);
    if (decision.finish) {
      // Reconstructs the message array a forced-finish call would have used
      // (no extra model call needed) so a streaming replay of the final
      // answer asks cleanly for a synthesis, instead of replaying the
      // [FINAL]/[CONTINUE] tag protocol and risking the tag leaking into the
      // streamed text.
      const finalizeContent = buildModeratorTurnContent(userContent, transcript, { forceFinish: true });
      return {
        content: decision.finalAnswer,
        usage: moderatorTurn.usage,
        messagesForFinalCall: buildTurnMessages(leadAgent, finalizeContent),
        aiOptions: moderatorTurn.aiOptions,
      };
    }
    // else: one more round.
  }

  // fixed_rounds (the only strategy that can fall through the loop above
  // without having already returned).
  const synthContent = buildSynthesisTurnContent(userContent, transcript);
  return await runAgentTurn(env, sessionId, leadAgent, synthContent, { actorSub });
}

// --- orchestrator ---

function buildOrchestratorTurnContent(userContent, transcript) {
  const discussion = transcript.length > 0 ? `\n\nHistórico da orquestração até agora:\n${formatTranscript(transcript)}` : "";
  return `Pergunta original do usuário: ${userContent}${discussion}`;
}

// docs/specs/agent-teams.md, "orchestrator": exact tool shape from the spec,
// with `next_agent.enum` filled in at runtime from the team's current
// (non-lead) members -- the spec's own JSON example doesn't show the enum
// but its surrounding text says next_agent "é validado contra os names dos
// membros atuais do team a cada chamada (lista montada em runtime, não
// fixa)"; adding it as a real enum (rather than only validating after the
// fact) gives the model the valid choices up front too.
function selectNextAgentTool(memberNames) {
  return {
    type: "function",
    function: {
      name: "select_next_agent",
      description: "Escolhe qual agent do team fala a seguir, ou finaliza a conversa com uma resposta.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["speak", "finish"] },
          next_agent: {
            type: "string",
            description: "Nome do agent que deve falar (obrigatório quando action=speak).",
            enum: memberNames,
          },
          final_answer: { type: "string", description: "Resposta final ao usuário (obrigatório quando action=finish)." },
        },
        required: ["action"],
      },
    },
  };
}

// Used only for the forced final call once max_orchestrator_steps is reached
// (docs/specs/agent-teams.md: "força uma última chamada só com action:
// finish disponível", the same "force a final answer" pattern already used
// by the plain tool-calling loop's max_tool_iterations ceiling).
function finishOnlyTool() {
  return {
    type: "function",
    function: {
      name: "select_next_agent",
      description: "Finaliza a conversa com uma resposta final ao usuário.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["finish"] },
          final_answer: { type: "string", description: "Resposta final ao usuário." },
        },
        required: ["action", "final_answer"],
      },
    },
  };
}

// The coordinator's own routing decision -- deliberately NOT routed through
// runAgentTurn/runToolCallingLoop: this is a bespoke tool-calling call whose
// only available tool is the synthetic select_next_agent, kept independent of
// whatever domain `tools` the coordinator agent itself might have configured
// (the spec's orchestrator mode says nothing about mixing the two; the
// coordinator's job here is routing, not answering with its own tools).
async function callCoordinator(env, sessionId, leadAgent, turnContent, tools) {
  const messages = buildTurnMessages(leadAgent, turnContent);
  const aiOptions = buildAiOptionsFromAgent(leadAgent);

  const result = await chatCompletionWithTools(env.AI, messages, { ...aiOptions, tools });

  await addMessage(env.CHAT_DB, {
    sessionId,
    role: "assistant",
    content: result.content ?? JSON.stringify({ tool_calls: result.toolCalls }),
    agentId: leadAgent.id,
  });

  return { result, messages, aiOptions };
}

// docs/specs/agent-teams.md, "orchestrator": the lead_agent_id decides, step
// by step, which other member speaks next (or finishes), via the synthetic
// select_next_agent tool -- reusing the function-calling infrastructure from
// docs/specs/agent-tool-calling.md. max_orchestrator_steps is the safety
// ceiling: reached without action: finish, one last call is forced with only
// the finish action available.
async function runOrchestrator(env, sessionId, team, members, userContent, actorSub) {
  const leadAgent = members.find((a) => a.id === team.lead_agent_id);
  const speakers = members.filter((a) => a.id !== team.lead_agent_id);
  const tool = selectNextAgentTool(speakers.map((a) => a.name));
  const maxSteps = team.max_orchestrator_steps ?? DEFAULT_MAX_ORCHESTRATOR_STEPS;

  const transcript = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    const isLastStep = step >= maxSteps;
    const turnContent = buildOrchestratorTurnContent(userContent, transcript);
    const { result, messages, aiOptions } = await callCoordinator(env, sessionId, leadAgent, turnContent, isLastStep ? [finishOnlyTool()] : [tool]);

    const call = result.toolCalls?.[0];
    if (!call) {
      // Coordinator answered in plain text instead of calling the tool --
      // treat it as the final answer rather than crashing (no verified
      // Workers AI behavior either way here, same caveat already accepted
      // for the plain tool-calling loop's own "Casos a verificar").
      return { content: result.content ?? "", usage: result.usage, messagesForFinalCall: messages, aiOptions };
    }

    const args = call.arguments || {};
    if (args.action === "finish" || isLastStep) {
      return { content: args.final_answer ?? result.content ?? "", usage: result.usage, messagesForFinalCall: messages, aiOptions };
    }

    const nextAgent = speakers.find((a) => a.name === args.next_agent);
    if (!nextAgent) {
      // Coordinator named an agent that isn't a valid (non-lead) member --
      // fed back as a normal continuation rather than aborting the whole
      // orchestration, mirroring the tool-calling loop's "a failing tool
      // never aborts the loop" philosophy, applied to a routing mistake.
      transcript.push({ agentName: "Coordenador", content: `Agente inválido selecionado: ${args.next_agent}` });
      continue;
    }

    const turn = await runAgentTurn(env, sessionId, nextAgent, buildOrchestratorTurnContent(userContent, transcript), { actorSub });
    transcript.push({ agentName: nextAgent.name, content: turn.content });
  }

  // Unreachable in practice (the isLastStep branch above always returns),
  // kept only so a misconfigured max_orchestrator_steps <= 0 fails loudly
  // instead of silently returning undefined.
  throw new Error("Orchestrator exceeded max_orchestrator_steps without finishing");
}

// Entry point used by index.mjs's handleSendMessage when a session's
// team_id is set. Returns { content, usage, messagesForFinalCall, aiOptions }
// uniformly across all 3 modes -- messagesForFinalCall/aiOptions let the
// caller replay the exact final prompt through chatCompletionStream() when
// the client asked for stream: true (docs/specs/agent-teams.md, "Streaming:
// mesmo padrão já estabelecido na ADR 0023").
export async function runTeamOrchestration(env, { sessionId, teamId, userContent, actorSub }) {
  const team = await getTeamById(env.AGENTS_DB, teamId);
  if (!team) {
    throw new Error(`Team not found: ${teamId}`);
  }

  const members = await loadMembers(env, team);

  if (team.orchestration_mode === "pipeline") {
    return await runPipeline(env, sessionId, members, userContent, actorSub);
  }
  if (team.orchestration_mode === "debate") {
    return await runDebate(env, sessionId, team, members, userContent, actorSub);
  }
  return await runOrchestrator(env, sessionId, team, members, userContent, actorSub);
}
