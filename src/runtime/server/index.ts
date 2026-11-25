import type { Client, EvaluationContext } from '@openfeature/server-sdk'
import {
  availabilityKey,
  type AvailabilityEvent,
  type AvailabilityEventContext,
  type AvailabilityOptions,
  type EvaluateDeclaration,
} from './event.js'

export type { AvailabilityEvent, AvailabilityOptions }
export type FeatureFlagClient = Pick<Client, 'getBooleanValue' | 'providerStatus'>
export type FeatureFlagClientFactory = () =>
  FeatureFlagClient | undefined | Promise<FeatureFlagClient | undefined>
export type FeatureEvaluationContextResolver<Event extends AvailabilityEvent = AvailabilityEvent> = (
  event: Event,
) => EvaluationContext | undefined | Promise<EvaluationContext | undefined>

function evaluate(event: AvailabilityEvent, ...args: Parameters<EvaluateDeclaration>) {
  const availability = (event?.context as AvailabilityEventContext | undefined)?.[availabilityKey]
  if (!availability)
    throw new Error(
      '[FEATURE_FLAGS_UNAVAILABLE] Availability requires an active Nitro request with feature.flags enabled.',
    )
  return availability(...args)
}

export async function isFeatureEnabled(
  event: AvailabilityEvent,
  id: string,
  options?: AvailabilityOptions,
) {
  return evaluate(event, 'feature', id, options)
}

export async function isGroupEnabled(
  event: AvailabilityEvent,
  id: string,
  options?: AvailabilityOptions,
) {
  return evaluate(event, 'group', id, options)
}
