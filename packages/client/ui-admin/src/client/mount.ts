/** Registers owner administration navigation and read-only query resources. */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-admin/remote'
import { RemoteError, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { AdminSnapshotId } from '@deepseek-ai/dsh-admin/types'
import { AdminIcon, AdminPage, type AdminInjected } from './AdminPage.tsx'
import { createAdminViewStore } from './view-store.ts'
import { parseAdminAddress, readAdmin, waitForRefresh } from './resources.ts'
import { en, zh } from './locales.ts'
import { initialCalendarFilter } from './dates.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { /** Administration labels and feedback. */ admin: keyof typeof en }
  interface ResourceProtocolMap { /** Last committed event observed by passive Session follow. */ adminactivity: number }
}

/** Browser query cadence and table limits. */
export interface Config {
  /** Milliseconds between refreshes while a page is visible. */
  refreshIntervalMs: number
  /** Rows requested per page. */
  pageSize: number
  /** Initial inclusive Beijing calendar range for overview and costs, in days. */
  initialDays: number
}
/** Validated deployment settings; refreshes stop when the page unmounts. */
export const Config: Schema<Config> = Schema.object({
  refreshIntervalMs: Schema.natural().min(1000).default(10000),
  initialDays: Schema.natural().min(1).max(365).default(7),
  pageSize: Schema.natural().min(1).max(100).default(50),
})
/** Services consumed by the administration plugin. */
export const inject = ['remote', 'slots', 'locale', 'remoteAccess', 'resources']

/**
 * Mount owner-only panels and release all queries with their resource holders.
 * @param ctx - browser plugin context.
 * @param config - validated query limits.
 */
export function registerAdminUi(ctx: Context, config: Config): void {
  const panelId = 'admin' as MainPanelId
  ctx.effect(() => ctx.locale.register('admin', { en, zh }))
  const t = ctx.locale.bind('admin')
  ctx.remoteAccess.whenAccess('admin/listSessions', function* () {
    yield ctx.resources.register<'admin'>({
      protocol: 'admin',
      async *open(address, { signal }) {
        const query = parseAdminAddress(address)
        while (!signal.aborted) {
          yield await readAdmin(ctx.remote.admin, query, signal)
          await waitForRefresh(signal, config.refreshIntervalMs)
        }
      },
    })
    yield ctx.resources.register<'admintool'>({
      protocol: 'admintool',
      async *open(address) {
        const params = new URL(address).searchParams
        const id = params.get('sessionId'), rawSeq = params.get('seq'), snapshot = params.get('snapshot')
        const seq = Number(rawSeq)
        if (id === null || snapshot === null || rawSeq === null || !Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid administration tool address')
        yield await ctx.remote.admin.getTool(id as SessionId, seq as SessionSeq, snapshot as AdminSnapshotId)
      },
    })
    yield ctx.resources.register<'adminchildren'>({
      protocol: 'adminchildren',
      async *open(address) {
        const query = parseAdminAddress(address)
        const snapshot = new URL(address).searchParams.get('snapshot')
        if (query.sessionId === null || snapshot === null) throw new Error('Invalid child conversation address')
        yield await ctx.remote.admin.listSessions({
          filter: { sessionId: query.sessionId, descendants: true }, offset: query.offset, limit: query.limit,
          sort: query.sort, snapshot: snapshot as AdminSnapshotId,
        })
      },
    })
    yield ctx.resources.register<'adminmessage'>({
      protocol: 'adminmessage',
      async *open(address) {
        const query = parseAdminAddress(address)
        const snapshot = new URL(address).searchParams.get('snapshot')
        if (query.sessionId === null || snapshot === null) throw new Error('Invalid administration message address')
        yield await ctx.remote.admin.listEvents({
          sessionId: query.sessionId, offset: query.offset, limit: 1, messagesOnly: true, snapshot: snapshot as AdminSnapshotId,
        })
      },
    })
    yield ctx.resources.register<'adminactivity'>({
      protocol: 'adminactivity',
      async *open(address, { signal }) {
        const params = new URL(address).searchParams
        const sessionId = params.get('sessionId'), parent = params.get('parent')
        if (sessionId === null) throw new Error('Missing administration conversation')
        const sessionAddress = parent === null
          ? { kind: 'session' as const, sessionId: sessionId as SessionId }
          : { kind: 'subagent' as const, parentSessionId: parent as SessionId, childSessionId: sessionId as SessionId, mode: 'unknown' as const }
        try {
          for await (const frame of ctx.remote.session.follow({ address: sessionAddress, activate: false, maxMessages: 1 }, signal)) {
            if (frame.type === 'snapshot') yield { ok: true, value: frame.cursor }
            else if (frame.type === 'event') yield { ok: true, value: frame.event.seq }
          }
        } catch (error) {
          if (signal.aborted) return
          ctx.logger.warn(error)
          yield { ok: false, error: new RemoteError('gateway/internal', 'Conversation activity stream failed', {}, { cause: error }) }
        }
      },
    })
    const face: AdminInjected = {
      pageSize: config.pageSize,
      async exportCsv(request) {
        const result = await ctx.remote.admin.exportCsv(request)
        if (!result.ok) return result
        const url = URL.createObjectURL(new Blob(['\uFEFF', result.value.csv], { type: 'text/csv;charset=utf-8' }))
        try {
          const anchor = document.createElement('a')
          anchor.href = url; anchor.download = result.value.filename
          document.body.append(anchor)
          try { anchor.click() } finally { anchor.remove() }
        } finally { URL.revokeObjectURL(url) }
        return { ok: true, value: undefined }
      },
      savePrice: (price, historical) => historical ? ctx.remote.admin.repriceHistory({ price }) : ctx.remote.admin.addPrice(price),
      async rebuild() {
        const result = await ctx.remote.admin.rebuildIndex()
        return result.ok ? { ok: true, value: undefined } : result
      },
    }
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: panelId, locale: 'admin', store: createAdminViewStore(initialCalendarFilter(Date.now(), config.initialDays)), inject: () => face,
    }, AdminPage))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: panelId, order: 20, locale: 'admin', label: () => t('title'),
    }, AdminIcon))
  })
}

/**
 * Mount administration Remote methods before their UI consumers.
 * @param ctx - caller-owned plugin lifetime.
 * @param contribution - generated administration Remote definitions.
 * @param config - validated query limits.
 * @returns disposer that withdraws UI before Remote methods.
 */
export async function mountAdmin(ctx: Context, contribution: TypertRemoteContribution, config: Config): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.admin', ...inject.slice(1)], (child) => { registerAdminUi(child, config) })
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
