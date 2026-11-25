import {
  AsyncLocalStorageTransactionContextPropagator,
  ErrorCode,
  TypedInMemoryProvider,
  NOOP_TRANSACTION_CONTEXT_PROPAGATOR,
  OpenFeature,
  ProviderEvents,
  ProviderStatus,
  type EvaluationContext,
} from '@openfeature/server-sdk'
import { expect, it, vi } from 'vitest'
import { isFeatureEnabled, type AvailabilityEvent } from '../src/runtime/server/index.js'
import { installAvailability } from '../src/runtime/server/plugin.js'
import type { DeclarationAvailability } from '../src/runtime/server/policy.js'

const entries: readonly DeclarationAvailability[] = [
  { id: 'shop', kind: 'feature', bindings: [{ key: 'shop', defaultValue: false }] },
]
const withDefaults = [
  ...entries,
  { id: 'fallback-on', kind: 'feature', bindings: [{ key: 'shop', defaultValue: true }] },
] satisfies readonly DeclarationAvailability[]

class Runtime {
  onRequest?: (event: AvailabilityEvent) => void
  onClose?: () => void

  hooks = {
    hook: (name: 'request' | 'close', handler: (() => void) | ((event: AvailabilityEvent) => void)) => {
      if (name === 'request') {
        this.onRequest = handler
        return () => { this.onRequest = undefined }
      }
      this.onClose = () => handler({ context: {} })
      return () => { this.onClose = undefined }
    },
  }

  request(): AvailabilityEvent {
    const event = { context: {} }
    this.onRequest?.(event)
    return event
  }

  close() {
    this.onClose?.()
  }
}

function shopFlag(value: boolean | string) {
  return { shop: { defaultVariant: 'selected', variants: { selected: value }, disabled: false } } as const
}

it.each(['invocation', 'transaction', 'client', 'global', 'before hook'] as const)(
  'evaluates the same event using its current %s context',
  async (source) => {
    class TargetingProvider extends TypedInMemoryProvider {
      override async resolveBooleanEvaluation(_key: string, _default: boolean, context: EvaluationContext) {
        return { value: context.targetingKey === 'on' }
      }
    }

    const runtime = new Runtime()
    const domain = 'up-nuxt-features-context'
    const previousContext = OpenFeature.getContext()
    const transaction = new AsyncLocalStorageTransactionContextPropagator()
    await OpenFeature.setProviderAndWait(domain, new TargetingProvider())
    const client = OpenFeature.getClient(domain)
    let hookTarget = 'off'
    const before = vi.fn(() => source === 'before hook' ? { targetingKey: hookTarget } : undefined)
    const after = vi.fn()
    client.addHooks({ before, after })
    if (source === 'transaction') OpenFeature.setTransactionContextPropagator(transaction)
    installAvailability(runtime, entries, async () => ({
      default: client,
      getEvaluationContext: (): EvaluationContext => source === 'invocation' ? { targetingKey: 'off' } : {},
    }))
    const event = runtime.request()
    function evaluate(targetingKey: string) {
      const context = { targetingKey }
      switch (source) {
        case 'invocation': return isFeatureEnabled(event, 'shop', { context })
        case 'transaction':
          return new Promise<boolean>((resolve, reject) => {
            OpenFeature.setTransactionContext(context, () => {
              isFeatureEnabled(event, 'shop').then(resolve, reject)
            })
          })
        case 'client': client.setContext(context); break
        case 'global': OpenFeature.setContext(context); break
        case 'before hook': hookTarget = targetingKey; break
      }
      return isFeatureEnabled(event, 'shop')
    }

    try {
      await expect(evaluate('on')).resolves.toBe(true)
      await expect(evaluate('off')).resolves.toBe(false)
      // Identical inputs still run the SDK's evaluation lifecycle.
      await expect(evaluate('off')).resolves.toBe(false)
      expect(before).toHaveBeenCalledTimes(3)
      expect(after).toHaveBeenCalledTimes(3)
    } finally {
      runtime.close()
      OpenFeature.setContext(previousContext)
      if (source === 'transaction') OpenFeature.setTransactionContextPropagator(NOOP_TRANSACTION_CONTEXT_PROPAGATOR)
      await OpenFeature.setProviderAndWait(domain, new TypedInMemoryProvider())
    }
  },
)

it('evaluates fresh values after SDK status transitions and provider replacement', async () => {
  const runtime = new Runtime()
  const domain = 'up-nuxt-features-status'
  const provider = new TypedInMemoryProvider(shopFlag(true))
  const initializing = Promise.withResolvers<void>()
  class StartingProvider extends TypedInMemoryProvider {
    async initialize() { await initializing.promise }
  }
  const client = OpenFeature.getClient(domain)
  installAvailability(runtime, withDefaults, async () => ({ default: client }))
  const event = runtime.request()
  const decisions = () => Promise.all([
    isFeatureEnabled(event, 'shop'), isFeatureEnabled(event, 'fallback-on'),
  ])
  const registration = OpenFeature.setProviderAndWait(domain, new StartingProvider(shopFlag(true)))
  try {
    expect(client.providerStatus).toBe(ProviderStatus.NOT_READY)
    await expect(decisions()).resolves.toEqual([false, true])
    initializing.resolve()
    await registration
    await OpenFeature.setProviderAndWait(domain, provider)
    expect(client.providerStatus).toBe(ProviderStatus.READY)
    await expect(decisions()).resolves.toEqual([true, true])

    provider.events.emit(ProviderEvents.Stale)
    expect(client.providerStatus).toBe(ProviderStatus.STALE)
    await expect(decisions()).resolves.toEqual([false, true])
    provider.putConfiguration(shopFlag(false))
    provider.events.emit(ProviderEvents.Ready)
    expect(client.providerStatus).toBe(ProviderStatus.READY)
    await expect(decisions()).resolves.toEqual([false, false])

    provider.events.emit(ProviderEvents.Error, { errorCode: ErrorCode.GENERAL })
    expect(client.providerStatus).toBe(ProviderStatus.ERROR)
    await expect(decisions()).resolves.toEqual([false, true])
    provider.putConfiguration(shopFlag(true))
    provider.events.emit(ProviderEvents.Ready)
    await expect(decisions()).resolves.toEqual([true, true])

    provider.events.emit(ProviderEvents.Error, { errorCode: ErrorCode.PROVIDER_FATAL })
    expect(client.providerStatus).toBe(ProviderStatus.FATAL)
    await expect(decisions()).resolves.toEqual([false, true])
    await OpenFeature.setProviderAndWait(domain, new TypedInMemoryProvider(shopFlag(false)))
    expect(client.providerStatus).toBe(ProviderStatus.READY)
    await expect(decisions()).resolves.toEqual([false, false])
  } finally {
    runtime.close()
    initializing.resolve()
    await registration
    await OpenFeature.setProviderAndWait(domain, new TypedInMemoryProvider())
  }
})

it('uses each binding default for SDK evaluation errors and picks up subsequent flag changes', async () => {
  class FailingProvider extends TypedInMemoryProvider {
    fail = false
    override resolveBooleanEvaluation(...args: Parameters<TypedInMemoryProvider['resolveBooleanEvaluation']>) {
      if (this.fail) throw new Error('test provider evaluation failure')
      return super.resolveBooleanEvaluation(...args)
    }
  }
  const domain = 'up-nuxt-features-fallback'
  const runtime = new Runtime()
  const provider = new FailingProvider()
  await OpenFeature.setProviderAndWait(domain, provider)
  const client = OpenFeature.getClient(domain)
  const errors = vi.fn()
  client.addHooks({ error: errors })
  installAvailability(runtime, withDefaults, async () => ({ default: client }))
  const event = runtime.request()
  const decisions = () => Promise.all([
    isFeatureEnabled(event, 'shop'), isFeatureEnabled(event, 'fallback-on'),
  ])
  try {
    await expect(decisions()).resolves.toEqual([false, true])
    provider.putConfiguration(shopFlag('wrong type'))
    await expect(decisions()).resolves.toEqual([false, true])
    provider.putConfiguration(shopFlag(true))
    provider.fail = true
    await expect(decisions()).resolves.toEqual([false, true])
    expect(errors).toHaveBeenCalledTimes(6)
    expect(client.providerStatus).toBe(ProviderStatus.READY)
    provider.fail = false
    await expect(decisions()).resolves.toEqual([true, true])
    provider.putConfiguration(shopFlag(false))
    await expect(decisions()).resolves.toEqual([false, false])
    expect(errors).toHaveBeenCalledTimes(6)
  } finally {
    runtime.close()
    await OpenFeature.setProviderAndWait(domain, new TypedInMemoryProvider())
  }
})

it('evaluates repeated flag keys on bound ancestors and the subject with their own hook context', async () => {
  const runtime = new Runtime()
  const domain = 'up-nuxt-features-ancestors'
  await OpenFeature.setProviderAndWait(domain, new TypedInMemoryProvider({
    shop: {
      defaultVariant: 'off',
      variants: { on: true, off: false },
      disabled: false,
      contextEvaluator: ({ targetingKey }) => targetingKey === 'on' ? 'on' : 'off',
    },
  }))
  const client = OpenFeature.getClient(domain)
  let targetingKey = 'on'
  client.addHooks({ before: () => ({ targetingKey }) })
  const bindings = [
    { key: 'shop', defaultValue: false },
    { key: 'shop', defaultValue: false },
  ]
  const resolutions = vi.fn()
  client.addHooks({ after: (_, { value }) => {
    resolutions(value)
    targetingKey = 'off'
  } })
  installAvailability(runtime, [{ id: 'shop/child', kind: 'feature', bindings }], async () => ({ default: client }))
  try {
    await expect(isFeatureEnabled(runtime.request(), 'shop/child')).resolves.toBe(false)
    expect(resolutions.mock.calls).toEqual([[true], [false]])
  } finally {
    runtime.close()
    await OpenFeature.setProviderAndWait(domain, new TypedInMemoryProvider())
  }
})

it('isolates application boot results and releases only its own hooks at close', async () => {
  let closes = 0
  class ApplicationProvider extends TypedInMemoryProvider {
    async onClose() { closes++ }
  }

  const a = new Runtime()
  const b = new Runtime()
  const shared = new Runtime()
  const provided = (value: boolean) => new ApplicationProvider({
    shop: { defaultVariant: 'value', variants: { value }, disabled: false },
  })
  const clientFor = async (domain: string, value: boolean) => {
    await OpenFeature.setProviderAndWait(domain, provided(value))
    return OpenFeature.getClient(domain)
  }
  const domainA = 'up-nuxt-features-test-a'
  const domainB = 'up-nuxt-features-test-b'
  const startup = vi.fn(() => clientFor(domainA, true))
  try {
    installAvailability(a, entries, async () => ({ default: startup }))
    installAvailability(b, entries, async () => ({ default: await clientFor(domainB, false) }))
    const oldRequest = a.request()
    await expect(Promise.all([
      isFeatureEnabled(oldRequest, 'shop'),
      isFeatureEnabled(a.request(), 'shop'),
      isFeatureEnabled(b.request(), 'shop'),
    ])).resolves.toEqual([true, true, false])
    expect(startup).toHaveBeenCalledOnce()
    installAvailability(shared, entries, async () => ({ default: OpenFeature.getClient(domainA) }))

    a.close()
    a.close()
    await expect(isFeatureEnabled(oldRequest, 'shop')).rejects.toThrow(/runtime has closed/)
    await expect(isFeatureEnabled(a.request(), 'shop')).rejects.toThrow(/active Nitro request/)
    await expect(isFeatureEnabled(b.request(), 'shop')).resolves.toBe(false)
    await expect(isFeatureEnabled(shared.request(), 'shop')).resolves.toBe(true)
    await expect(OpenFeature.getClient(domainA).getBooleanValue('shop', false)).resolves.toBe(true)
    expect(closes).toBe(0)
  } finally {
    a.close()
    b.close()
    shared.close()
    await Promise.all([
      OpenFeature.setProviderAndWait(domainA, new TypedInMemoryProvider({})),
      OpenFeature.setProviderAndWait(domainB, new TypedInMemoryProvider({})),
    ])
  }
})

it.each(['resolve', 'reject'] as const)('ignores a late factory %s after timeout and retries only on a fresh boot', async (settle) => {
  const domain = 'up-nuxt-features-late-' + settle
  const onClose = vi.fn()
  class AppProvider extends TypedInMemoryProvider {
    async onClose() { onClose() }
  }
  await OpenFeature.setProviderAndWait(domain, new AppProvider(shopFlag(true)))
  const client = OpenFeature.getClient(domain)
  vi.useFakeTimers()
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const runtime = new Runtime()
  const fresh = new Runtime()
  const pending = Promise.withResolvers<typeof client>()
  const factory = vi.fn(() => pending.promise)
  try {
    installAvailability(runtime, withDefaults, async () => ({ default: factory }))
    const decision = Promise.all([
      isFeatureEnabled(runtime.request(), 'shop'), isFeatureEnabled(runtime.request(), 'fallback-on'),
    ])
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(decision).resolves.toEqual([false, true])
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('startup timed out'))
    expect(factory).toHaveBeenCalledOnce()
    if (settle === 'resolve') pending.resolve(client)
    else pending.reject(new Error('late factory rejection'))
    await vi.advanceTimersByTimeAsync(0)
    await expect(isFeatureEnabled(runtime.request(), 'shop')).resolves.toBe(false)
    expect(factory).toHaveBeenCalledOnce()
    expect(warnings).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    runtime.close()
    installAvailability(fresh, entries, async () => ({ default: () => client }))
    await expect(isFeatureEnabled(fresh.request(), 'shop')).resolves.toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  } finally {
    runtime.close()
    fresh.close()
    warnings.mockRestore()
    vi.useRealTimers()
    await OpenFeature.setProviderAndWait(domain, new TypedInMemoryProvider())
  }
})

it.each(['resolve', 'reject'] as const)('releases pending startup on close before a late factory %s', async (settle) => {
  vi.useFakeTimers()
  const runtime = new Runtime()
  const pending = Promise.withResolvers<ReturnType<typeof OpenFeature.getClient>>()
  const factory = vi.fn(() => pending.promise)
  try {
    installAvailability(runtime, entries, async () => ({ default: factory }))
    const event = runtime.request()
    const requested = expect(isFeatureEnabled(event, 'shop')).rejects.toThrow(/runtime has closed/)
    await vi.advanceTimersByTimeAsync(0)
    expect(factory).toHaveBeenCalledOnce()
    runtime.close()
    runtime.close()
    await requested
    expect(runtime.onRequest).toBeUndefined()
    expect(runtime.onClose).toBeUndefined()
    if (settle === 'resolve') pending.resolve(OpenFeature.getClient())
    else pending.reject(new Error('factory rejection after close'))
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
    await expect(isFeatureEnabled(event, 'shop')).rejects.toThrow(/runtime has closed/)
    await expect(isFeatureEnabled(runtime.request(), 'shop')).rejects.toThrow(/active Nitro request/)
  } finally {
    runtime.close()
    vi.useRealTimers()
  }
})
