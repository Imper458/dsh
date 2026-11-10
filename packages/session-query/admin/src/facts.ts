/** Private, replayable administration facts; payloads remain in the session journal. */
import { z } from 'zod'
import { lastAssistantStreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-title-llm'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const seq = count.transform(SessionSeq)
/** Validates a persisted call's counters before cost estimation. */
export const usageSchema = z.object({
  seq, time: count, kind: z.enum(['conversation', 'compaction', 'title']),
  provider: z.string().nullable(), model: z.string().nullable(),
  inputTokens: count.nullable(), cacheReadTokens: count.nullable(), outputTokens: count.nullable(),
  unsupported: z.boolean(),
}).strict()
/** Validates persisted tool metadata before detail lookup. */
export const toolSchema = z.object({
  seq, name: z.string(), time: count, nested: z.boolean(), resultSeq: seq.nullable(),
  durationMs: count.nullable(), status: z.enum(['running', 'success', 'error', 'interrupted']),
}).strict()
/** Persisted facts contain metadata per executed call, without transcript or tool payload copies. */
export const adminFactsSchema = z.object({
  id: z.string().transform(SessionId), parentId: z.string().transform(SessionId).nullable(),
  createdAt: count, updatedAt: count, title: z.string(), workspace: z.string().nullable(),
  inherited: count, throughSeq: z.number().int().min(-1),
  state: z.enum(['running', 'completed', 'failed', 'interrupted', 'idle']),
  route: z.object({ provider: z.string(), model: z.string() }).nullable(),
  pendingAttempt: usageSchema.nullable(),
  usage: z.record(z.string(), usageSchema), tools: z.record(z.string(), toolSchema),
  compactions: z.record(z.string(), z.object({ seq, time: count })),
}).strict()
/** Domain-owned metadata reconstructed through the registered host projection. */
export type AdminFacts = z.infer<typeof adminFactsSchema>
/** One model attempt before price lookup. */
export type UsageFact = z.infer<typeof usageSchema>
/** One tool call before its payload is requested. */
export type ToolFact = z.infer<typeof toolSchema>

function counters(usage: TokenUsage | undefined): Pick<UsageFact, 'inputTokens' | 'cacheReadTokens' | 'outputTokens' | 'unsupported'> {
  return {
    inputTokens: usage?.inputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    unsupported: (usage?.cacheWriteTokens ?? 0) !== 0,
  }
}
function attempt(state: AdminFacts, seqValue: ReturnType<typeof SessionSeq>, time: number): UsageFact {
  return { seq: seqValue, time, kind: 'conversation', provider: state.route?.provider ?? null,
    model: state.route?.model ?? null, ...counters(undefined) }
}

/**
 * Host-only projection used by the derived SQLite index.
 * One metadata row per call is retained for the administrator's paginated audit queries.
 */
export const adminFactsDefinition: ProjectionDefinition<'adminFacts', AdminFacts> = {
  key: 'adminFacts', stateVersion: 1, stateSchema: adminFactsSchema,
  init: (header, inherited) => ({
    id: header.id, parentId: header.parentSession ?? null, title: '', workspace: header.cwd ?? null,
    createdAt: header.createdAt, updatedAt: header.createdAt, inherited, throughSeq: -1,
    state: 'idle', route: null, pendingAttempt: null, usage: {}, tools: {}, compactions: {},
  }),
  apply: (state, event) => {
    if (event.type === 'request/header') {
      const { provider, model } = event.data.header.config
      const route = { provider, model }
      const pending = state.pendingAttempt
      return { ...state, route, pendingAttempt: pending === null ? null : { ...pending, ...route } }
    }
    if (event.type === 'session/title') return { ...state, title: event.data.title }
    if (event.seq < state.inherited) return state
    const base = { ...state, throughSeq: event.seq, updatedAt: event.time }
    switch (event.type) {
      case 'turn/start': return { ...base, state: 'running' }
      case 'turn/end': {
        const reason = event.data.reason.kind
        const tools = Object.fromEntries(Object.entries(state.tools).map(([key, tool]) => [key,
          tool.status === 'running' ? { ...tool, status: 'interrupted' as const } : tool]))
        return { ...base, tools, state: reason === 'error' ? 'failed'
          : reason === 'aborted' || reason === 'interrupted' ? 'interrupted' : 'completed' }
      }
      case 'step/start':
      case 'llm/retry-started': return { ...base, pendingAttempt: attempt(state, event.seq, event.time) }
      case 'step/end': return { ...base, pendingAttempt: null }
      case 'assistant/message':
      case 'assistant/attempt': {
        const previous = state.pendingAttempt
        if (previous === null) return state
        const usage = event.type === 'assistant/message'
          ? event.data.usage ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
          : lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
        const route = event.type === 'assistant/message' ? event.data.message.source : state.route
        return { ...base, usage: { ...state.usage, [String(previous.seq)]: {
          ...previous, provider: route?.provider ?? previous.provider, model: route?.model ?? previous.model,
          ...counters(usage),
        } } }
      }
      case 'session/title-llm-request': return { ...base, usage: { ...state.usage, [String(event.seq)]: {
        seq: event.seq, time: event.time, kind: 'title', ...event.data.route, ...counters(undefined),
      } } }
      case 'session/title-llm-result': {
        const key = String(event.data.requestSeq)
        const previous = state.usage[key]
        return previous === undefined ? state : { ...base, usage: { ...state.usage,
          [key]: { ...previous, ...counters(event.data.usage) } } }
      }
      case 'compaction/start': return { ...base, compactions: { ...state.compactions,
        [event.data.compactionId]: { seq: event.seq, time: event.time } } }
      case 'compaction/summary': {
        const start = state.compactions[event.data.compactionId]
        return { ...base, usage: { ...state.usage, [String(event.seq)]: {
          seq: event.seq, time: start?.time ?? event.time, kind: 'compaction',
          provider: event.data.provider, model: event.data.model, ...counters(event.data.usage),
          unsupported: event.data.llmStreamCall !== true || (event.data.usage?.cacheWriteTokens ?? 0) !== 0,
        } } }
      }
      case 'tool/call': return { ...base, tools: { ...state.tools, [event.data.callId]: {
        seq: event.seq, name: event.data.name, time: event.time, nested: false,
        durationMs: null, resultSeq: null, status: 'running',
      } } }
      case 'tool/result': {
        const key = event.data.message.source.callId
        const call = Object.hasOwn(state.tools, key) ? state.tools[key] : undefined
        if (call === undefined || call.resultSeq !== null) return state
        return { ...base, tools: { ...state.tools, [key]: { ...call, resultSeq: event.seq,
          durationMs: event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN' || event.data.error?.code === 'TOOL_NOT_STARTED'
            ? null : Math.max(0, event.time - call.time), status: event.data.error?.code === 'ABORTED' || event.data.error?.code === 'ABORTED_BEFORE_DISPATCH'
            || event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN' || event.data.error?.code === 'TOOL_NOT_STARTED'
            ? 'interrupted' : event.data.message.isError ? 'error' : 'success' } } }
      }
      case 'tool/ptc-dispatch-start': return { ...base, tools: { ...state.tools, [event.data.subCallId]: {
        seq: event.seq, name: event.data.name, time: event.time, nested: true,
        durationMs: null, resultSeq: null, status: 'running',
      } } }
      case 'tool/ptc-dispatch': {
        const key = event.data.subCallId
        const call = Object.hasOwn(state.tools, key) ? state.tools[key] : undefined
        if (call?.resultSeq !== undefined && call.resultSeq !== null) return state
        return { ...base, tools: { ...state.tools, [key]: {
          seq: call?.seq ?? event.seq, name: event.data.name, time: call?.time ?? event.time,
          nested: true, resultSeq: event.seq, durationMs: call === undefined ? null : Math.max(0, event.time - call.time),
          status: event.data.error?.code === 'ABORTED' || event.data.error?.code === 'ABORTED_BEFORE_DISPATCH'
            || event.data.error?.code === 'TOOL_OUTCOME_UNKNOWN' || event.data.error?.code === 'TOOL_NOT_STARTED'
            ? 'interrupted' : event.data.isError ? 'error' : 'success',
        } } }
      }
      default: return state
    }
  },
}
