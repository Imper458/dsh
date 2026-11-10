/** Read-only administration tables and explicit price administration. */
import { useState, type CSSProperties } from 'react'
import { Button, Checkbox, IconDatabaseOutlineRegular, IconLoadingOutlineRegular, Input, Menu, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  AdminCostTotal, AdminEventRow, AdminExportRequest, AdminFilter, AdminPage, AdminPriceInput, AdminPriceVersion,
  AdminSessionRow, AdminSnapshotId, AdminToolRow, AdminUsageRow, AdminUsageSummary,
} from '@deepseek-ai/dsh-admin/types'
import type { AdminView, createAdminViewStore } from './view-store.ts'
import { adminAddress } from './resources.ts'
import { beijingTimestamp, calendarDate } from './dates.ts'
import css from './AdminPage.module.css'

/** Callbacks and static query limits supplied by the plugin. */
export interface AdminInjected {
  pageSize: number
  exportCsv: (request: AdminExportRequest) => Promise<RemoteResult<void>>
  savePrice: (price: AdminPriceInput, historical: boolean) => Promise<RemoteResult<AdminPriceVersion>>
  rebuild: () => Promise<RemoteResult<void>>
}
/** Full main-panel props derived from its registration. */
export type AdminPageProps = PropsRuntime<'main'> & PropsLocale<'admin'> & PropsStore<ReturnType<typeof createAdminViewStore>> & InjectFace<AdminInjected>
type Translate = PropsLocale<'admin'>['t']

function number(value: number | null, t: Translate): string {
  return value === null ? t('unavailable') : new Intl.NumberFormat().format(value)
}
function date(value: number | null, t: Translate): string {
  return value === null ? t('unavailable') : new Date(value).toLocaleString(undefined, { timeZone: 'Asia/Shanghai' })
}
function cost(values: readonly AdminCostTotal[], t: Translate): string {
  return values.length === 0 ? t('unavailable') : values.map(value => `${value.currency} ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(value.amount)}`).join(' · ')
}
function stateLabel(value: AdminSessionRow['state'] | AdminToolRow['status'], t: Translate): string {
  return t(value === 'failed' ? 'failedState' : value)
}

/**
 * Show the administration navigation, selected query and owner operations.
 * @param props - generated view actions, resource hook and Remote callbacks.
 * @returns the administration main panel.
 */
export function AdminPage({ useStore, actions, useResource, pageSize, exportCsv, savePrice, rebuild, t }: AdminPageProps) {
  const view = useStore(value => value)
  const resource = useResource<'admin'>(adminAddress(view, pageSize))
  const data = resource.value
  const events = data?.events
  const sessionId = view.sessionId
  const liveParams = new URLSearchParams()
  if (view.sessionId !== null) liveParams.set('sessionId', view.sessionId)
  if (data?.detail?.session.parentId != null) liveParams.set('parent', data.detail.session.parentId)
  const activity = useResource<'adminactivity'>(view.sessionId !== null && data?.detail ? `dsh-resource://adminactivity/?${liveParams}` : '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<'stale' | 'operationFailed' | null>(null)
  const [expandedTool, setExpandedTool] = useState<{ sessionId: SessionId; seq: number; snapshot: AdminSnapshotId } | null>(null)
  const page = data?.sessions ?? data?.tools ?? data?.usage ?? data?.events
  const run = async (operation: () => Promise<RemoteResult<void>>) => {
    setBusy(true); setFailure(null)
    try {
      const result = await operation()
      if (!result.ok) setFailure(result.error.code === 'admin/error' && result.error.details.reason === 'stale-snapshot' ? 'stale' : 'operationFailed')
    } catch (_error) {
      setFailure('operationFailed')
    } finally { setBusy(false) }
  }
  const exportKind = view.sessionId !== null
    ? view.detailTab === 'tools' ? 'tools' : view.detailTab === 'usage' ? 'usage' : null
    : view.tab === 'sessions' ? 'sessions' : view.tab === 'tools' ? 'tools' : view.tab === 'costs' ? 'usage' : null
  const selectedFilter: AdminFilter = view.sessionId === null ? view.filter : { sessionId: view.sessionId, descendants: view.descendants }
  const changeTab = (tab: AdminView['tab']) => { setExpandedTool(null); setFailure(null); actions.tab(tab) }
  const selectSession = (id: SessionId | null) => { setExpandedTool(null); setFailure(null); actions.session(id) }
  const refresh = () => { setExpandedTool(null); setFailure(null); actions.refresh() }
  return <section className={css.page} data-admin-page>
    <header className={css.header}>
      <div><h1>{t('title')}</h1><p className={css.muted}>{t('subtitle')}</p></div>
      <div className={css.actions}>
        <Button variant="outline" disabled={busy} onClick={refresh}>{t('refresh')}</Button>
        {exportKind !== null && <Button variant="outline" disabled={busy || !page || resource.status === 'failed'} onClick={() => {
          if (page) void run(() => exportCsv({ kind: exportKind, filter: selectedFilter, snapshot: page.snapshot }))
        }}>{t('export')}</Button>}
      </div>
    </header>
    <SegmentedTabs value={view.tab} onChange={changeTab} label={t('title')} className={css.tabs} items={[
      { value: 'overview', label: t('overview'), id: 'admin-tab-overview', panelId: 'admin-content' },
      { value: 'sessions', label: t('sessions'), id: 'admin-tab-sessions', panelId: 'admin-content' },
      { value: 'tools', label: t('tools'), id: 'admin-tab-tools', panelId: 'admin-content' },
      { value: 'costs', label: t('costs'), id: 'admin-tab-costs', panelId: 'admin-content' },
    ]} />
    <div id="admin-content" role="tabpanel" aria-labelledby={`admin-tab-${view.tab}`} className={css.content}>
      {view.sessionId === null && <Filters key={`${view.tab}:${view.revision}`} filter={view.filter} sort={view.sort} order={actions.sort} apply={actions.filter} t={t} />}
      {data && <div className={css.indexStatus} role="status">
        <span>{data.index.state === 'indexing' ? t('indexRunning', { done: String(data.index.indexedSessions), total: String(data.index.totalSessions) })
          : data.index.state === 'error' || data.index.failedSessions > 0 ? t('indexError')
            : data.index.indexedAt === null ? t('indexIdle') : t('indexReady', { time: date(data.index.indexedAt, t) })}</span>
        {(data.index.state === 'error' || data.index.state === 'idle' || data.index.failedSessions > 0) && <Button size="sm" disabled={busy} onClick={() => { void run(async () => { const result = await rebuild(); if (result.ok) actions.refresh(); return result }) }}>{t('rebuild')}</Button>}
      </div>}
      {(failure !== null || resource.status === 'failed') && <div role="alert" className={css.notice}>
        <span>{failure !== null ? t(failure) : resource.failure?.code === 'admin/error' && resource.failure.details.reason === 'stale-snapshot' ? t('stale') : t('failed')}</span>
        <Button size="sm" onClick={refresh}>{t('retry')}</Button>
      </div>}
      {!data && resource.status !== 'failed' && <div className={css.skeleton} role="status" aria-label={t('loading')}><span /><span /><span /></div>}
      {data?.detail && <div className={css.detailHeader}>
        <Button size="sm" onClick={() => { selectSession(null) }}>{t('back')}</Button>
        <h2>{data.detail.session.title || t('untitled')}</h2>
        <p className={css.identifier}>{data.detail.session.id}</p>
        {activity.value !== undefined && activity.value > data.detail.throughSeq && <p role="status" className={css.muted}>{t('liveChanged')}</p>}
        {activity.status === 'failed' && <p role="alert">{t('failed')}</p>}
        {data.detail.session.parentId !== null && <Button size="sm" onClick={() => { selectSession(data.detail?.session.parentId ?? null) }}>{t('parent')}</Button>}
        <ChildConversations key={data.detail.session.id} sessionId={data.detail.session.id} snapshot={data.detail.snapshot}
          limit={pageSize} useResource={useResource} select={selectSession} refresh={refresh} t={t} />
        <SegmentedTabs value={view.detailTab} label={t('details')} onChange={(tab) => { setExpandedTool(null); actions.detailTab(tab) }} items={[
          { value: 'chat', label: t('chat'), id: 'admin-detail-chat', panelId: 'admin-detail-content' },
          { value: 'tools', label: t('tools'), id: 'admin-detail-tools', panelId: 'admin-detail-content' },
          { value: 'usage', label: t('usage'), id: 'admin-detail-usage', panelId: 'admin-detail-content' },
        ]} />
        {view.detailTab !== 'chat' && <Checkbox checked={view.descendants} onChange={actions.descendants} label={t('descendants')} />}
      </div>}
      {data?.summary && (view.tab === 'overview' || view.tab === 'costs' || view.detailTab === 'usage' && view.sessionId !== null) && <Summary summary={data.summary} overview={view.tab === 'overview' && view.sessionId === null} t={t} />}
      <div {...view.sessionId !== null ? { id: 'admin-detail-content', role: 'tabpanel', 'aria-labelledby': `admin-detail-${view.detailTab}` } : {}}>
        {data?.sessions && <Sessions page={data.sessions} select={selectSession} t={t} />}
        {data?.tools && <Tools page={data.tools} select={selectSession} expand={(row) => {
          if (data.tools) setExpandedTool({ sessionId: row.sessionId, seq: row.seq, snapshot: data.tools.snapshot })
        }} t={t} />}
        {data?.usage && <Usage page={data.usage} select={selectSession} t={t} />}
        {data?.events && <div className={css.messages}>
          {data.events.items.length === 0 && <p className={css.empty}>{t('empty')}</p>}
          {sessionId !== null && events?.items.map((event, index) => <ChatMessage key={event.seq} event={event}
            sessionId={sessionId} snapshot={events.snapshot} offset={view.offset + index} useResource={useResource} t={t} />)}
        </div>}
      </div>
      {page && <Pagination offset={view.offset} limit={pageSize} total={page.total}
        select={(offset) => { setExpandedTool(null); actions.page(offset) }} t={t} />}
      {expandedTool !== null && <ToolDetail selected={expandedTool} useResource={useResource}
        close={() => { setExpandedTool(null) }} t={t} />}
      {data?.summary && view.tab === 'costs' && <div className={css.breakdowns}>
        <CostTable title={t('costByModel')} label={t('model')} limit={pageSize} t={t}
          key={`models:${JSON.stringify(view.filter)}`}
          rows={data.summary.models.map(row => ({ label: row.model ?? t('unavailable'), calls: row.calls, costs: row.costs }))} />
        <CostTable title={t('costByDate')} label={t('date')} limit={pageSize} t={t}
          key={`daily:${JSON.stringify(view.filter)}`} rows={data.summary.daily.map(row => ({ label: row.date, calls: row.calls, costs: row.costs }))} />
      </div>}
      {data?.prices && <PriceSettings prices={data.prices} save={savePrice} changed={refresh} t={t} />}
    </div>
  </section>
}

function ChatMessage({ event, sessionId, snapshot, offset, useResource, t }: {
  event: AdminEventRow
  sessionId: SessionId
  snapshot: AdminSnapshotId
  offset: number
  useResource: AdminPageProps['useResource']
  t: Translate
}) {
  const [expanded, setExpanded] = useState(false)
  const params = new URLSearchParams({ section: 'chat', sessionId, snapshot, offset: String(offset), limit: '1', sort: 'oldest' })
  const resource = useResource<'adminmessage'>(expanded ? `dsh-resource://adminmessage/?${params}` : '')
  const message = expanded ? resource.value?.items[0] ?? event : event
  return <article className={css.message}>
    <header><span>{event.role === null ? event.type : t(event.role)}</span><time>{date(event.time, t)}</time>
      {event.inherited && <span>{t('inherited')}</span>}</header>
    {message.text ? <p className={css.messageText}>{message.text}</p> : <p className={css.muted}>{t('nonText')}</p>}
    {!message.text && message.data && <details><summary>{t('raw')}</summary><pre>{message.data}</pre></details>}
    {event.truncated && <Button size="sm" aria-expanded={expanded} onClick={() => { setExpanded(!expanded) }}>{t(expanded ? 'collapse' : 'expandMessage')}</Button>}
    {expanded && resource.status === 'loading' && <p role="status">{t('loading')}</p>}
    {expanded && resource.status === 'failed' && <p role="alert">{resource.failure?.code === 'admin/error' && resource.failure.details.reason === 'stale-snapshot' ? t('stale') : t('failed')}</p>}
    {expanded && resource.value && message.truncated && <p className={css.muted}>{t('messageLimit')}</p>}
  </article>
}

function ChildConversations({ sessionId, snapshot, limit, useResource, select, refresh, t }: {
  sessionId: SessionId
  snapshot: AdminSnapshotId
  limit: number
  useResource: AdminPageProps['useResource']
  select: (id: SessionId) => void
  refresh: () => void
  t: Translate
}) {
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const params = new URLSearchParams({ section: 'sessions', sessionId, snapshot, offset: String(offset), limit: String(limit), sort: 'oldest' })
  const resource = useResource<'adminchildren'>(open ? `dsh-resource://adminchildren/?${params}` : '')
  const page = resource.value
  const children = page?.items.filter(row => row.id !== sessionId)
  return <div className={css.children}>
    <Button size="sm" aria-expanded={open} onClick={() => { setOpen(!open) }}>{t('children')}</Button>
    {open && <>
      {resource.status === 'failed' && <div role="alert" className={css.notice}><span>{resource.failure?.code === 'admin/error' && resource.failure.details.reason === 'stale-snapshot' ? t('stale') : t('failed')}</span><Button size="sm" onClick={refresh}>{t('retry')}</Button></div>}
      {!page && resource.status !== 'failed' && <p role="status">{t('loading')}</p>}
      {children && <ul data-admin-children>{children.map(row => <li key={row.id}><button className={css.textButton} onClick={() => { select(row.id) }}>{row.title || t('untitled')}</button><span className={css.identifier}>{row.id}</span></li>)}</ul>}
      {page && page.total <= 1 && <p className={css.muted}>{t('noChildren')}</p>}
      {page && page.total > limit && <div className={css.pagination}>
        <Button size="sm" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - limit)) }}>{t('previous')}</Button>
        <Button size="sm" disabled={offset + limit >= page.total} onClick={() => { setOffset(offset + limit) }}>{t('next')}</Button>
      </div>}
    </>}
  </div>
}

function Filters({ filter, sort, order, apply, t }: { filter: AdminFilter; sort: AdminView['sort']; order: (value: AdminView['sort']) => void; apply: (value: AdminFilter) => void; t: Translate }) {
  const [state, setState] = useState(filter.state)
  const [stateMenu, setStateMenu] = useState(false)
  const [query, setQuery] = useState(filter.query ?? '')
  const [model, setModel] = useState(filter.model ?? '')
  const [from, setFrom] = useState(filter.from === undefined ? '' : calendarDate(filter.from))
  const [to, setTo] = useState(filter.to === undefined ? '' : calendarDate(filter.to - 1))
  return <form className={css.filters} onSubmit={(event) => {
    event.preventDefault()
    const end = to ? beijingTimestamp(to) + 86400000 : null
    apply({
      ...state ? { state } : {}, ...query.trim() ? { query: query.trim() } : {},
      ...model.trim() ? { model: model.trim() } : {}, ...from ? { from: beijingTimestamp(from) } : {}, ...end ? { to: end } : {},
    })
  }}>
    <p className={css.timezone}>{t('timezone')}</p>
    <label className={css.search}>{t('search')}<Input value={query} onChange={(event) => { setQuery(event.target.value) }} /></label>
    <label>{t('model')}<Input value={model} onChange={(event) => { setModel(event.target.value) }} /></label>
    <label>{t('from')}<Input type="date" value={from} onChange={(event) => { setFrom(event.target.value) }} /></label>
    <label>{t('to')}<Input type="date" value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value) }} /></label>
    <Menu open={stateMenu} onClose={() => { setStateMenu(false) }} portal autoFocus
      anchor={<Button variant="outline" aria-haspopup="menu" aria-expanded={stateMenu} onClick={() => { setStateMenu(!stateMenu) }}>{state === undefined ? t('stateAll') : stateLabel(state, t)}</Button>}
      selectedId={state ?? 'all'} items={['all', 'running', 'completed', 'failed', 'interrupted', 'idle'].map(id => ({ id, label: id === 'all' ? t('stateAll') : stateLabel(id as NonNullable<AdminFilter['state']>, t) }))}
      onSelect={(id) => { setState(id === 'all' ? undefined : id as NonNullable<AdminFilter['state']>); setStateMenu(false) }} />
    <Button variant="outline" onClick={() => { order(sort === 'newest' ? 'oldest' : 'newest') }}>{t(sort)}</Button>
    <Button variant="outline" type="submit">{t('apply')}</Button>
    <Button onClick={() => { setQuery(''); setModel(''); setFrom(''); setTo(''); setState(undefined); apply({}) }}>{t('clear')}</Button>
  </form>
}
function Summary({ summary, overview, t }: { summary: AdminUsageSummary; overview: boolean; t: Translate }) {
  const peak = Math.max(1, ...summary.daily.map(day => day.inputTokens + day.outputTokens))
  return <div className={css.summary}>
    <dl className={css.metrics}>
      {overview && <><div><dt>{t('sessions')}</dt><dd>{number(summary.sessions.total, t)}</dd></div><div><dt>{t('running')}</dt><dd>{number(summary.sessions.running, t)}</dd></div><div><dt>{t('failedState')}</dt><dd>{number(summary.sessions.failed, t)}</dd></div></>}
      {([
        ['calls', summary.calls], ['input', summary.inputTokens], ['cache', summary.cacheReadTokens], ['output', summary.outputTokens],
        ['priced', summary.pricedCalls], ['missingUsage', summary.missingUsage], ['missingPrice', summary.missingPrice], ['unsupported', summary.unsupportedCalls],
      ] as const).map(([label, value]) => <div key={label}><dt>{t(label)}</dt><dd>{number(value, t)}</dd></div>)}
      <div><dt>{t('cost')}</dt><dd>{cost(summary.costs, t)}</dd></div>
    </dl>
    <p className={css.muted}>{t('estimate')}</p>
    {overview && summary.daily.length > 0 && <figure className={css.trend}>
      <figcaption>{t('dailyTokens')}</figcaption>
      <div className={css.bars} role="list">
        {summary.daily.map(day => <div role="listitem" key={day.date} className={css.barItem}>
          <span>{number(day.inputTokens + day.outputTokens, t)}</span>
          <div className={css.barTrack}><div className={css.bar} style={{ '--admin-bar-height': `${(day.inputTokens + day.outputTokens) / peak * 100}%` } as CSSProperties} /></div>
          <span>{day.date}</span>
        </div>)}
      </div>
    </figure>}
  </div>
}
function Sessions({ page, select, t }: { page: AdminPage<AdminSessionRow>; select: (id: SessionId) => void; t: Translate }) {
  if (page.items.length === 0) return <p className={css.empty}>{t('empty')}</p>
  return <div className={css.tableScroll}><table data-admin-table="sessions"><thead><tr>
    <th>{t('conversation')}</th><th>{t('state')}</th><th>{t('model')}</th><th>{t('updated')}</th><th>{t('tokens')}</th><th>{t('cost')}</th><th>{t('tools')}</th>
  </tr></thead><tbody>{page.items.map(row => <tr key={row.id} data-admin-session-id={row.id}>
    <td><button className={css.textButton} onClick={() => { select(row.id) }}>{row.title || t('untitled')}</button><span className={css.identifier}>{row.id}</span>
      {row.workspace && <span className={css.identifier}>{row.workspace}</span>}</td>
    <td>{stateLabel(row.state, t)}</td><td>{row.models.join(', ') || t('unavailable')}</td><td>{date(row.updatedAt, t)}</td>
    <td>{number(row.inputTokens + row.outputTokens, t)}{row.missingUsage > 0 && <span className={css.muted}>{t('missingUsage')}: {number(row.missingUsage, t)}</span>}</td>
    <td>{cost(row.costs, t)}{row.missingPrice > 0 && <span className={css.muted}>{t('missingPrice')}: {number(row.missingPrice, t)}</span>}</td><td>{number(row.tools, t)}</td>
  </tr>)}</tbody></table></div>
}
function CostTable({ title, label, rows, limit, t }: {
  title: string
  label: string
  rows: { label: string; calls: number; costs: AdminCostTotal[] }[]
  limit: number
  t: Translate
}) {
  const [offset, setOffset] = useState(0)
  return <section><h3>{title}</h3>
    {rows.length === 0 ? <p className={css.muted}>{t('empty')}</p> : <div className={css.tableScroll}><table>
      <thead><tr><th>{label}</th><th>{t('calls')}</th><th>{t('cost')}</th></tr></thead>
      <tbody>{rows.slice(offset, offset + limit).map(row => <tr key={row.label}>
        <td>{row.label}</td><td>{number(row.calls, t)}</td><td>{cost(row.costs, t)}</td>
      </tr>)}</tbody>
    </table></div>}
    {rows.length > limit && <Pagination offset={offset} limit={limit} total={rows.length} select={setOffset} t={t} />}
  </section>
}
function Tools({ page, select, expand, t }: {
  page: AdminPage<AdminToolRow>
  select: (id: SessionId) => void
  expand: (row: AdminToolRow) => void
  t: Translate
}) {
  if (page.items.length === 0) return <p className={css.empty}>{t('empty')}</p>
  return <div className={css.tableScroll}><table data-admin-table="tools"><thead><tr><th>{t('name')}</th><th>{t('conversation')}</th><th>{t('state')}</th><th>{t('time')}</th><th>{t('duration')}</th><th>{t('details')}</th></tr></thead><tbody>
    {page.items.map(row => <tr key={`${row.sessionId}:${row.seq}`}>
      <td>{row.name}{row.nested && <span className={css.muted}>{t('nested')}</span>}</td>
      <td><button className={css.textButton} onClick={() => { select(row.sessionId) }}>{row.sessionId}</button></td>
      <td>{stateLabel(row.status, t)}</td><td>{date(row.time, t)}</td><td>{row.durationMs === null ? t('unavailable') : t('milliseconds', { value: number(row.durationMs, t) })}</td>
      <td><Button size="sm" onClick={() => { expand(row) }}>{t('details')}</Button></td>
    </tr>)}
  </tbody></table></div>
}
function Usage({ page, select, t }: { page: AdminPage<AdminUsageRow>; select: (id: SessionId) => void; t: Translate }) {
  if (page.items.length === 0) return <p className={css.empty}>{t('empty')}</p>
  const labels = { priced: 'pricedCoverage', 'missing-usage': 'missingUsageCoverage', 'missing-price': 'missingPriceCoverage', unsupported: 'unsupportedCoverage' } as const
  return <div className={css.tableScroll}><table data-admin-table="usage"><thead><tr><th>{t('conversation')}</th><th>{t('kind')}</th><th>{t('model')}</th><th>{t('time')}</th><th>{t('input')}</th><th>{t('cache')}</th><th>{t('output')}</th><th>{t('cost')}</th><th>{t('coverage')}</th></tr></thead><tbody>
    {page.items.map(row => <tr key={`${row.sessionId}:${row.seq}:${row.kind}`}>
      <td><button className={css.textButton} onClick={() => { select(row.sessionId) }}>{row.sessionId}</button></td><td>{t(`${row.kind}Kind`)}</td><td>{row.model ?? t('unavailable')}</td><td>{date(row.time, t)}</td>
      <td>{number(row.inputTokens, t)}</td><td>{number(row.cacheReadTokens, t)}</td><td>{number(row.outputTokens, t)}</td>
      <td>{row.amount === null || row.currency === null ? t('unavailable') : cost([{ amount: row.amount, currency: row.currency }], t)}</td><td>{t(labels[row.coverage])}</td>
    </tr>)}
  </tbody></table></div>
}
function Pagination({ offset, limit, total, select, t }: {
  offset: number
  limit: number
  total: number
  select: (offset: number) => void
  t: Translate
}) {
  return <div className={css.pagination}>
    <span>{t('pagination', { from: String(total === 0 ? 0 : offset + 1), to: String(Math.min(offset + limit, total)), total: String(total) })}</span>
    <Button size="sm" disabled={offset === 0} onClick={() => { select(Math.max(0, offset - limit)) }}>{t('previous')}</Button>
    <Button size="sm" disabled={offset + limit >= total} onClick={() => { select(offset + limit) }}>{t('next')}</Button>
  </div>
}
function ToolDetail({ selected, useResource, close, t }: {
  selected: { sessionId: SessionId; seq: number; snapshot: AdminSnapshotId }
  useResource: AdminPageProps['useResource']
  close: () => void
  t: Translate
}) {
  const params = new URLSearchParams({ sessionId: selected.sessionId, seq: String(selected.seq), snapshot: selected.snapshot })
  const resource = useResource<'admintool'>(`dsh-resource://admintool/?${params}`)
  return <section className={css.toolDetail}>
    <header><h3>{resource.value?.tool.name ?? t('details')}</h3><Button size="sm" onClick={close}>{t('close')}</Button></header>
    {resource.status === 'failed' && <p role="alert">{resource.failure?.code === 'admin/error' && resource.failure.details.reason === 'stale-snapshot' ? t('stale') : t('failed')}</p>}
    {resource.status === 'loading' && <IconLoadingOutlineRegular className={css.spinner} aria-label={t('loading')} />}
    {resource.value && <><h4>{t('arguments')}</h4><pre>{resource.value.arguments}</pre><h4>{t('result')}</h4><pre>{resource.value.result ?? t('noResult')}</pre>{resource.value.truncated && <p>{t('truncated')}</p>}</>}
  </section>
}

function PriceSettings({ prices, save, changed, t }: {
  prices: AdminPriceVersion[]
  save: AdminInjected['savePrice']
  changed: () => void
  t: Translate
}) {
  const [historical, setHistorical] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'invalidPrice' | 'operationFailed' | null>(null)
  return <details className={css.prices}><summary>{t('prices')}</summary>
    <p className={css.muted}>{t('perMillion')}</p>
    {[...new Set(prices.flatMap(price => price.deepseekSchedule ? [price.deepseekSchedule.validUntil] : []))].map(until =>
      <p key={until} className={css.muted}>{t('officialSchedule', { until: date(until, t) })}</p>)}
    {prices.length === 0 ? <p>{t('noPrices')}</p> : <div className={css.tableScroll}><table><thead><tr><th>{t('model')}</th><th>{t('currency')}</th><th>{t('effective')}</th><th>{t('inputRate')}</th><th>{t('cacheRate')}</th><th>{t('outputRate')}</th></tr></thead><tbody>
      {prices.map(price => <tr key={price.id}>
        <td>{price.model}{price.deepseekSchedule && <span className={css.muted}>{t('officialScheduleLabel')}</span>}</td><td>{price.currency}</td><td>{date(price.effectiveFrom, t)}</td>
        <td>{price.inputPerMillion}</td><td>{price.cacheReadPerMillion}</td><td>{price.outputPerMillion}</td>
      </tr>)}
    </tbody></table></div>}
    <form className={css.priceForm} data-admin-price-form onSubmit={(event) => {
      event.preventDefault()
      const fields = new FormData(event.currentTarget)
      const value = (name: string): string => {
        const field = fields.get(name)
        return typeof field === 'string' ? field : ''
      }
      const price: AdminPriceInput = {
        model: value('model').trim(), currency: value('currency').trim().toUpperCase(),
        effectiveFrom: beijingTimestamp(value('effectiveFrom')),
        inputPerMillion: value('inputPerMillion'), cacheReadPerMillion: value('cacheReadPerMillion'), outputPerMillion: value('outputPerMillion'),
      }
      if (!price.model || !/^[A-Z]{3}$/.test(price.currency) || !Number.isFinite(price.effectiveFrom) || [price.inputPerMillion, price.cacheReadPerMillion, price.outputPerMillion].some(value => !/^\d+(?:\.\d+)?$/.test(value))) { setError('invalidPrice'); return }
      setBusy(true); setError(null)
      void save(price, historical).then((result) => { if (result.ok) changed(); else setError('operationFailed') }).catch(() => { setError('operationFailed') }).finally(() => { setBusy(false) })
    }}>
      <label>{t('model')}<Input name="model" required disabled={busy} /></label>
      <label>{t('currency')}<Input name="currency" required pattern="[A-Za-z]{3}" disabled={busy} /></label>
      <label>{t('effective')}<Input name="effectiveFrom" type="datetime-local" required disabled={busy} /></label>
      <label>{t('inputRate')}<Input name="inputPerMillion" inputMode="decimal" required disabled={busy} /></label>
      <label>{t('cacheRate')}<Input name="cacheReadPerMillion" inputMode="decimal" required disabled={busy} /></label>
      <label>{t('outputRate')}<Input name="outputPerMillion" inputMode="decimal" required disabled={busy} /></label>
      <div className={css.priceAction}><Checkbox checked={historical} onChange={setHistorical} label={t('historical')} disabled={busy} />
        {historical && <p className={css.muted}>{t('historicalHelp')}</p>}
        {error !== null && <p role="alert">{t(error)}</p>}
        <Button type="submit" variant="outline" disabled={busy}>{t(historical ? 'saveHistorical' : 'savePrice')}</Button>
      </div>
    </form>
  </details>
}

/**
 * Render the shared list icon for the administration sidebar entry.
 * @param props - requested sidebar glyph size.
 * @returns the library's database icon.
 */
export function AdminIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconDatabaseOutlineRegular size={size} />
}
