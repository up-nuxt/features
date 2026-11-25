import type { EvaluationContext } from '@openfeature/server-sdk'
import type {
  FeatureEvaluationContextResolver,
  FeatureFlagClient,
  FeatureFlagClientFactory,
} from './index.js'
import {
  availabilityKey,
  type AvailabilityEvent,
  type AvailabilityEventContext,
  type EvaluateDeclaration,
} from './event.js'
import { evaluateAvailability, type DeclarationAvailability } from './policy.js'

interface ClientModule {
  readonly default: FeatureFlagClient | FeatureFlagClientFactory
  readonly getEvaluationContext?: FeatureEvaluationContextResolver
}

interface ClientState {
  readonly client: FeatureFlagClient
  readonly getEvaluationContext?: FeatureEvaluationContextResolver
}

interface NitroRuntime {
  readonly hooks: {
    hook(name: 'request', handler: (event: AvailabilityEvent) => void): () => void
    hook(name: 'close', handler: () => void): () => void
  }
}

const startupTimeout = 5_000

function warn(message: string) {
  console.warn(`[@up-nuxt/features] ${message}`)
}

function initializeClient(load: () => Promise<ClientModule>) {
  let timer: ReturnType<typeof setTimeout>
  let pending = true
  let finish: (value?: ClientState) => void
  const ready = new Promise<ClientState | undefined>((resolve) => {
    finish = (value) => {
      if (!pending) return
      pending = false
      clearTimeout(timer)
      resolve(value)
    }
    timer = setTimeout(() => {
      warn('OpenFeature client startup timed out. Using binding defaults.')
      finish()
    }, startupTimeout)
  })
  void Promise.resolve()
    .then(load)
    .then(async (module) => {
      if (!pending) return
      if (!Object.hasOwn(module, 'default')) throw new TypeError('Missing OpenFeature client export')
      const { default: provided, getEvaluationContext } = module
      const client = typeof provided === 'function' ? await provided() : provided
      if (client && typeof client.getBooleanValue !== 'function')
        throw new TypeError('Invalid OpenFeature client')
      if (getEvaluationContext !== undefined && typeof getEvaluationContext !== 'function')
        throw new TypeError('Invalid OpenFeature context resolver')
      finish(client ? { client, getEvaluationContext } : undefined)
    })
    .catch(() => {
      if (!pending) return
      warn('OpenFeature client startup failed. Using binding defaults.')
      finish()
    })
  return { ready, stop: () => finish() }
}

export function installAvailability(
  app: NitroRuntime,
  entries: readonly DeclarationAvailability[],
  load?: () => Promise<ClientModule>,
) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  let startup = load && initializeClient(load)
  let closed = false

  const unhook = app.hooks.hook('request', (event) => {
    // Capture this event only. Re-read application context for each invocation, since
    // middleware can enrich the event after Nitro's request hook runs.
    const evaluate: EvaluateDeclaration = async (kind, id, options) => {
      if (closed) throw new Error('[FEATURE_FLAGS_UNAVAILABLE] Availability runtime has closed.')
      const entry = byId.get(id)
      if (!entry) throw new Error('[FEATURE_FLAGS_ID] Unknown declaration ID.')
      if (entry.kind !== kind)
        throw new Error(`[FEATURE_FLAGS_KIND] Expected a ${kind} declaration.`)
      if (!entry.bindings.length) return true

      const state = await startup?.ready
      if (closed) throw new Error('[FEATURE_FLAGS_UNAVAILABLE] Availability runtime has closed.')
      const useDefaults = () => entry.bindings.every(({ defaultValue }) => defaultValue)
      if (!state) return useDefaults()
      const { client, getEvaluationContext } = state

      let context: EvaluationContext
      try {
        context = structuredClone({ ...(await getEvaluationContext?.(event)), ...options?.context })
      } catch {
        warn('OpenFeature evaluation context failed. Using binding defaults.')
        return useDefaults()
      }
      return evaluateAvailability(entry.bindings, async ({ key, defaultValue }) => {
        if (closed) throw new Error('[FEATURE_FLAGS_UNAVAILABLE] Availability runtime has closed.')
        if (client.providerStatus !== 'READY') return defaultValue
        try {
          // The SDK supplies the current global, transaction, client and hook context.
          const value = await client.getBooleanValue(key, defaultValue, structuredClone(context))
          return typeof value === 'boolean' ? value : defaultValue
        } catch {
          warn('OpenFeature evaluation failed. Using the binding default.')
          return defaultValue
        }
      })
    }
    const requestContext: AvailabilityEventContext = event.context
    requestContext[availabilityKey] = evaluate
  })

  const unhookClose = app.hooks.hook('close', () => {
    closed = true
    unhook()
    unhookClose()
    startup?.stop()
    startup = undefined
  })
}
