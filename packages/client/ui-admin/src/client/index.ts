/** Browser entry for the owner administration panel. */
import type { Context } from '@deepseek-ai/cordis'
import remote from '@deepseek-ai/dsh-admin/remote'
import { Config, mountAdmin } from './mount.ts'

export { Config, inject } from './mount.ts'

/**
 * Mount the generated Remote contribution and its administration UI.
 * @param ctx - browser plugin lifetime.
 * @param config - validated query configuration.
 * @returns disposer that removes consumers before their Remote methods.
 */
export async function apply(ctx: Context, config: Config): Promise<() => Promise<void>> {
  return await mountAdmin(ctx, remote, config)
}
