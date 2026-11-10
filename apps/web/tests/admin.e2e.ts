/** Owner administration over a replayed DeepSeek conversation and its persisted cold history. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AdminPage, AdminSessionRow, AdminUsageSummary } from '@deepseek-ai/dsh-admin/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { launchWebScaffold, seedSession, webSnapshotMode } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const fixture = fileURLToPath(new URL('../../../snapshots/web/minimal-preset/session.v4.jsonl', import.meta.url))
const overlay = fileURLToPath(new URL('../../cli/config/examples/admin.overlay.yml', import.meta.url))

it.skipIf(webSnapshotMode() === 'record')('shows recorded DeepSeek work and exports the same cost selection without resuming history', async () => {
  const scaffold = await launchWebScaffold({
    replayFixture: fixture,
    compareReplaySession: 'read-only',
    extraOverlayPath: [overlay, fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url))],
  })
  onTestFinished(() => scaffold.close())
  const handle = await scaffold.ctx.agents.create({
    sessionId: SessionId('admin-deepseek-replay'),
    meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: ctx => scaffold.ctx.agentPresets.mount(ctx, 'minimal').then(() => undefined),
  })
  onTestFinished(() => handle.dispose())
  handle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: "Use the bash tool to run exactly: printf 'MINIMAL_BASH_CARD_OK\\n'. Then reply exactly MINIMAL_PRESET_REQUEST_OK and stop." }],
    source: { kind: 'user' },
  }))
  await handle.agent.whenIdle()
  const coldId = await seedSession(scaffold, await readFile(fixture, 'utf8'), 'admin-cold-history', 'minimal')
  const seq = handle.agent.session.seq
  const before = scaffold.ctx.agents.list().map(agent => agent.id)
  const rpc = async <T>(method: string, args: object): Promise<T> => {
    const response = await scaffold.hostFetch(`/api/admin/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: method, method: `admin/${method}`, payload: { args } }),
    })
    expect(response.ok).toBe(true)
    const body = await response.json() as { result: { ok: boolean; value: T; error?: object } }
    expect(body.result, method).toMatchObject({ ok: true })
    return body.result.value
  }
  await rpc('rebuildIndex', {})
  await expect.poll(async () => (await rpc<AdminPage<AdminSessionRow>>('listSessions', { request: {} })).total).toBe(2)
  const selected = { sessionId: handle.agent.id }
  const usage = await rpc<AdminUsageSummary>('usageSummary', { request: { filter: selected } })
  expect({ calls: usage.calls, input: usage.inputTokens, output: usage.outputTokens, missingUsage: usage.missingUsage })
    .toEqual({ calls: 2, input: 20, output: 8, missingUsage: 2 })

  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  await page.goto(scaffold.authenticatedUrl)
  await page.getByRole('button', { name: 'Administration', exact: true }).click()
  const panel = page.locator('[data-admin-page]')
  await panel.locator('[data-admin-table="sessions"]').waitFor()
  expect(await panel.getByLabel('From', { exact: true }).inputValue()).toBe('')
  await panel.locator(`[data-admin-session-id="${coldId}"]`).getByRole('button').first().click()
  await panel.getByText('MINIMAL_PRESET_REQUEST_OK', { exact: true }).waitFor()
  await panel.locator('#admin-detail-tools').click()
  await panel.locator('[data-admin-table="tools"]').getByText('bash', { exact: true }).waitFor()
  await panel.locator('[data-admin-table="tools"]').getByRole('button', { name: 'Details', exact: true }).click()
  await panel.getByRole('heading', { name: 'Arguments', exact: true }).waitFor()
  await expect.poll(() => panel.locator('pre').allTextContents()).toContainEqual(expect.stringContaining('MINIMAL_BASH_CARD_OK'))
  expect(scaffold.ctx.agents.list().map(agent => agent.id)).toEqual(before)
  expect(handle.agent.session.seq).toBe(seq)
  expect(scaffold.ctx.agents.get(coldId)).toBeUndefined()

  await panel.getByRole('button', { name: 'Back to conversations', exact: true }).click()
  await panel.getByRole('tab', { name: 'Costs', exact: true }).click()
  expect(await panel.getByLabel('From', { exact: true }).inputValue()).not.toBe('')
  await panel.getByRole('button', { name: 'Clear filters', exact: true }).click()
  await panel.locator('[data-admin-table="usage"]').waitFor()
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Export CSV', exact: true }).click()
  const download = await downloadPromise
  const path = await download.path()
  if (path === null) throw new Error('CSV download did not produce a local file')
  const csv = await readFile(path, 'utf8')
  expect(csv).toContain('deepseek-v4-flash')
  expect(csv).toContain('missing-usage')
  expect(csv).not.toContain('MINIMAL_PRESET_REQUEST_OK')

  await panel.getByText('DeepSeek prices', { exact: true }).click()
  const priceForm = panel.locator('[data-admin-price-form]')
  await priceForm.getByLabel('Model', { exact: true }).fill('deepseek-v4-flash')
  await priceForm.getByLabel('Currency', { exact: true }).fill('CNY')
  await priceForm.getByLabel('Effective from (Beijing time)', { exact: true }).fill('2099-01-01T00:00')
  await priceForm.getByLabel('Uncached input', { exact: true }).fill('1')
  await priceForm.getByLabel('Cached input', { exact: true }).fill('0.1')
  await priceForm.getByLabel('Output', { exact: true }).fill('2')
  await priceForm.getByRole('button', { name: 'Save new price', exact: true }).click()
  await expect.poll(async () => (await rpc<unknown[]>('listPrices', {})).length).toBe(1)
  await page.context().setOffline(true)
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
  await panel.getByRole('alert').first().waitFor()
  await page.context().setOffline(false)
  await panel.getByRole('button', { name: 'Retry', exact: true }).click()
  await panel.locator('[data-admin-table="usage"]').waitFor()
  await expect.poll(() => panel.getByRole('alert').count()).toBe(0)

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await page.setViewportSize({ width: 680, height: 900 })
  expect(await panel.getByRole('button', { name: 'Export CSV', exact: true }).isVisible()).toBe(true)
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await panel.getByRole('button', { name: 'Export CSV', exact: true }).isVisible()).toBe(true)
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
})
