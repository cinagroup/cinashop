export * from '../../scripts/admin-frontend-api-audit';
import {buildAdminFrontendApiAuditReport as buildCurrentReport} from '../../scripts/admin-frontend-api-audit';
import {projectAcceptedCheckpointReport} from './migrationMergeSourceBinding';
export const buildAdminFrontendApiAuditReport=()=>projectAcceptedCheckpointReport(buildCurrentReport());
