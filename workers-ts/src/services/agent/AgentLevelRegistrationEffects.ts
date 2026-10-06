import type { Container } from '@/lib/di';
import { upgradeAgentLevelsForUser } from './AgentLevelTaskService';
import { emitOperationalEvent, operationalErrorCode } from '@/utils/observability';

/** Call only after registration/relationship commit. The old AgentJob records
 * an upgrade failure without failing a registration that already committed.
 * Login and the authenticated progress read retry evaluation independently. */
export async function evaluateAgentLevelsAfterRegistration(container:Container,uid:number):Promise<void> {
  try { await upgradeAgentLevelsForUser(container,uid); }
  catch(error) { emitOperationalEvent('error',{event:'agent_level_registration_upgrade_failed',component:'login',
    operation:'agent_level_upgrade',outcome:'failure',errorCode:operationalErrorCode(error)}); }
}
