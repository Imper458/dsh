/** Administration contributions leave with their plugin and never mount for a refused principal. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply as resourcesApply, inject as resourcesInject } from '@deepseek-ai/dsh-client-resources/client'
import { staticAccessPlugin, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { Config, inject, registerAdminUi } from '../src/client/mount.ts'
import { adminAddress } from '../src/client/resources.ts'
import { createAdminViewStore } from '../src/client/view-store.ts'

for (const allowed of [true, false]) {
  it(`registers only permitted administration and removes it on unload (allowed=${String(allowed)})`, async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SlotRegistry).await()
      ctx.provide('locale', new LocaleRuntime(ctx))
      new TestRemote(ctx)
      await ctx.plugin(staticAccessPlugin(() => allowed)).await()
      await ctx.plugin({ inject: resourcesInject, apply: resourcesApply }).await()
      const slots = ctx.get('slots') as SlotRegistry
      slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' }, 'sidebar.panellist': { kind: 'list', scope: 'root' } } } as never, () => null)
      const fiber = ctx.plugin({ inject, apply: (child: Context) => {
        registerAdminUi(child, Config({ refreshIntervalMs: 10000, pageSize: 50, initialDays: 7 }))
      } })
      await fiber.await()
      expect(slots.entries('main')).toHaveLength(allowed ? 1 : 0)
      expect(slots.entries('sidebar.panellist')).toHaveLength(allowed ? 1 : 0)
      const address = adminAddress(createAdminViewStore().create().getSnapshot(), 50)
      expect(ctx.resources.source(address).getSnapshot().status).toBe(allowed ? 'loading' : 'none')
      await fiber.dispose()
      expect(slots.entries('main')).toHaveLength(0)
      expect(slots.entries('sidebar.panellist')).toHaveLength(0)
      expect(ctx.resources.source(address).getSnapshot().status).toBe('none')
    } finally { await ctx.fiber.dispose() }
  })
}
