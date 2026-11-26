import { BlindfillError } from '../../core/types.js';

/**
 * Android actuator: NOT IMPLEMENTED (see SECURITY.md, known gap 7).
 * The core already supports android targets (package + signer binding in core/policy.ts);
 * only the device-side actuator is missing. Every method fails closed.
 */
export class AndroidActuator {
  constructor() {
    throw new BlindfillError('ACTUATOR', 'The Android actuator is not implemented yet (stub only).');
  }
}
