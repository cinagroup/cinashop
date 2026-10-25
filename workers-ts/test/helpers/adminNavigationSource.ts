import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ADMIN_NAVIGATION_SOURCE_FILES, hasAdminNavigationMenu } from '../../scripts/admin-navigation-source';

/** Read the connected layout/component/inventory, independent of test cwd. */
export function readAdminNavigationSources(): Record<string, string> {
  return Object.fromEntries(Object.entries(ADMIN_NAVIGATION_SOURCE_FILES).map(([role, path]) =>
    [role, readFileSync(resolve(import.meta.dirname, '../../..', path), 'utf8')]));
}
export function hasCurrentAdminNavigationMenu(path: string, permissionPath = path): boolean {
  return hasAdminNavigationMenu(readAdminNavigationSources(), path, permissionPath);
}
