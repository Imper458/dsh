/** Shared administration navigation and filter state. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AdminFilter } from '@deepseek-ai/dsh-admin/types'

/** Main administration section. */
export type AdminTab = 'overview' | 'sessions' | 'tools' | 'costs'
/** Selected conversation section. */
export type DetailTab = 'chat' | 'tools' | 'usage'
/** View state contains no server-owned records. */
export interface AdminView {
  tab: AdminTab
  sessionId: SessionId | null
  detailTab: DetailTab
  filter: AdminFilter
  filterCustomized: boolean
  offset: number
  revision: number
  descendants: boolean
  sort: 'newest' | 'oldest'
}
type AdminActions = {
  tab: (draft: AdminView, tab: AdminTab) => void
  session: (draft: AdminView, id: SessionId | null) => void
  detailTab: (draft: AdminView, tab: DetailTab) => void
  filter: (draft: AdminView, filter: AdminFilter) => void
  sort: (draft: AdminView, value: AdminView['sort']) => void
  page: (draft: AdminView, offset: number) => void
  refresh: (draft: AdminView) => void
  descendants: (draft: AdminView, value: boolean) => void
}
/**
 * Create the registration-owned navigation store.
 * @param initialFilter - default calendar range for overview and costs.
 * @returns a view store whose filters reset pagination.
 */
export function createAdminViewStore(initialFilter: AdminFilter = {}): EngineStoreHandle<AdminView, AdminActions> {
  return defineStore({
    init: (): AdminView => ({ tab: 'sessions', sessionId: null, detailTab: 'chat', filter: {}, filterCustomized: false, offset: 0, revision: 0, descendants: false, sort: 'newest' }),
    actions: {
      tab: (draft: AdminView, tab: AdminTab) => {
        draft.tab = tab; draft.sessionId = null; draft.offset = 0
        if (!draft.filterCustomized) draft.filter = tab === 'overview' || tab === 'costs' ? initialFilter : {}
      },
      session: (draft: AdminView, id: SessionId | null) => {
        draft.sessionId = id; draft.tab = 'sessions'; draft.detailTab = 'chat'; draft.offset = 0; draft.descendants = false
        if (!draft.filterCustomized) draft.filter = {}
      },
      detailTab: (draft: AdminView, tab: DetailTab) => { draft.detailTab = tab; draft.offset = 0 },
      filter: (draft: AdminView, filter: AdminFilter) => { draft.filter = filter; draft.filterCustomized = true; draft.offset = 0 },
      sort: (draft: AdminView, value: 'newest' | 'oldest') => { draft.sort = value; draft.offset = 0 },
      page: (draft: AdminView, offset: number) => { draft.offset = offset },
      refresh: (draft: AdminView) => { draft.revision++; draft.offset = 0 },
      descendants: (draft: AdminView, value: boolean) => { draft.descendants = value; draft.offset = 0 },
    },
  })
}
