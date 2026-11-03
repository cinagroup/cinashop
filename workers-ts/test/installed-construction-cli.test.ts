import { describe, expect, it } from 'vitest';
import { auditInstalledPublicConstruction, INSTALLED_CONSTRUCTION_PROFILE as profile,
  parseInstalledConstructionArguments } from '../scripts/installed-construction-audit';

describe('explicit owned installed-construction diagnostic entry', () => {
  it('requires the exact named profile and JSON output', () => {
    expect(() => parseInstalledConstructionArguments(['--profile', profile, '--json'])).not.toThrow();
  });

  it.each([
    [], ['--json'], ['--profile', profile], ['--profile', 'unknown', '--json'],
    ['--json', '--profile', profile], ['--profile', profile, '--json', '--accept'],
    ['--profile', profile, '--json', '--url', 'postgres://other.invalid/production'],
    ['--profile', profile, '--json', '--profile', profile],
  ].map(args => ({ args })))('rejects unreviewed argument vector %j before any database operation', ({ args }) => {
    expect(() => parseInstalledConstructionArguments(args)).toThrow('exact explicit installed-construction profile');
  });

  it('rejects an implicit or unknown construction before connecting or reading source files', async () => {
    await expect(auditInstalledPublicConstruction(undefined, '')).rejects.toThrow('Explicit installed-construction profile required');
    await expect(auditInstalledPublicConstruction('postgres://other.invalid/production', 'unknown'))
      .rejects.toThrow('Explicit installed-construction profile required');
  });

  it.each([undefined, 'invalid', 'postgres://finance_test:fixture@other.invalid/cinashop_finance_test',
    'postgres://finance_test:fixture@127.0.0.1/production',
    'postgres://another:fixture@127.0.0.1/cinashop_finance_test',
    'postgres://finance_test:fixture@127.0.0.1/cinashop_finance_test?options=unsafe',
  ])('rejects a target outside the dedicated loopback test service: %j', async target => {
    await expect(auditInstalledPublicConstruction(target, profile)).rejects.toThrow();
  });
});
