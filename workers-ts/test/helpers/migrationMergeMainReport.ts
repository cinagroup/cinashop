export * from '../../scripts/admin-frontend-api-audit';
import {buildAdminFrontendApiAuditReport as buildCurrentReport} from '../../scripts/admin-frontend-api-audit';
import {projectMigrationMergeReport} from './migrationMergeSourceBinding';
export const buildAdminFrontendApiAuditReport=()=>projectMigrationMergeReport(buildCurrentReport(),'main');
