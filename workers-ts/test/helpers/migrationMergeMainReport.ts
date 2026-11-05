export * from '../../scripts/admin-frontend-api-audit';
import {buildAdminFrontendApiAuditReport as buildCurrentReport} from '../../scripts/admin-frontend-api-audit';
import {projectMigrationMergeReport} from './migrationMergeSourceBinding';
import {projectMembershipHistoricalReport} from './rechargeNoticeSourceContinuity';
export const buildAdminFrontendApiAuditReport=()=>projectMigrationMergeReport(projectMembershipHistoricalReport(buildCurrentReport()),'main');
