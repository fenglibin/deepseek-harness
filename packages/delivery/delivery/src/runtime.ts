/** Runtime constructors and protocol constants for the delivery domain. */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { DeliveryErrorCode, DeliveryTaskId as DeliveryTaskIdType } from './types.ts'

/** Version of the delivery change payload. */
export const DELIVERY_CHANGE_VERSION = 1

/**
 * Brand a string as a delivery task id.
 * @param id - raw task identifier.
 * @returns the same string with the compile-time brand.
 */
export function DeliveryTaskId(id: string): DeliveryTaskIdType {
  return id as DeliveryTaskIdType
}

/** Error returned by the delivery domain boundary. */
export class DeliveryError extends HarnessError {
  /** Stable machine-routable classification narrowed to the delivery codes. */
  declare readonly code: DeliveryErrorCode
}
