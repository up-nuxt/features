import type { EvaluationContext } from '@openfeature/server-sdk'
import type { DeclarationAvailability } from './policy.js'

export interface AvailabilityEvent {
  readonly context: Record<string, unknown>
}

export interface AvailabilityOptions {
  context?: EvaluationContext
}

export type EvaluateDeclaration = (
  kind: DeclarationAvailability['kind'],
  id: string,
  options?: AvailabilityOptions,
) => Promise<boolean>

export const availabilityKey = Symbol.for('@up-nuxt/features:availability')

export type AvailabilityEventContext = AvailabilityEvent['context'] & {
  [availabilityKey]?: EvaluateDeclaration
}
