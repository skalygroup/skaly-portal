import { configure } from '@testing-library/react';

/**
 * Testing Library's `asyncUtilTimeout` defaults to 1000ms, and every `waitFor`
 * in this suite inherits it. The DOM work being waited on is milliseconds; the
 * 1s ceiling only ever fires when the machine is busy — 36 jsdom workers in
 * parallel, or a full API suite finishing in the next terminal. That turns a
 * load measurement into a test result: the settings-permissions PUT assertion
 * failed once at 1358ms and passed alone at 1.4s total.
 *
 * Raised, not removed. A genuinely broken mutation still fails, five seconds
 * later; only the contention flake goes away.
 */
configure({ asyncUtilTimeout: 5000 });
