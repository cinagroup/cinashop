const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = __dirname;
const source = String.raw`\\tsclient\I\cinagroup\cinashop`;
const local = path.join(root, 'cinashop-migration-20261013-HUPOBq');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const changes = [
  {
    path: 'workers-ts/src/services/other/LegacyShareCodeService.ts',
    replacements: [
      [
        '  async code(input: ReturnType<typeof parseLegacyShareInput>, actor: LegacyShareActor, officialBrowser: boolean) {',
        '  /** Legacy personal spread-code alias; it requires a configured mini-program channel. */\n  async routineCode(actor: LegacyShareActor): Promise<string> {\n    const result = await this.code(parseLegacyShareInput(\'-1\', \'0\', new URLSearchParams()), actor, false, { requireMini: true });\n    if (!result.routineUrl) throw new ServiceUnavailableException(\'分销小程序图片暂不可用，请稍后重试\');\n    return result.routineUrl;\n  }\n  async code(input: ReturnType<typeof parseLegacyShareInput>, actor: LegacyShareActor, officialBrowser: boolean, options: { requireMini?: boolean } = {}) {',
      ],
      [
        '    const current = await this.snapshot(input.type,input.id,actor.uid,input,officialBrowser,actor), descriptor = current.descriptor;',
        '    const current = await this.snapshot(input.type,input.id,actor.uid,input,officialBrowser,actor), descriptor = current.descriptor;\n    if (options.requireMini && !descriptor.miniApp) throw new ServiceUnavailableException(\'小程序分销码未配置\');',
      ],
    ],
  },
  {
    path: 'workers-ts/src/services/user/UserProfileService.ts',
    replacements: [
      ['import { WechatMiniProgramCodeService } from "@/services/wechat/WechatMiniProgramCodeService";', 'import { LegacyShareCodeService, type LegacyShareActor } from "@/services/other/LegacyShareCodeService";'],
      ['  async routineCode(uid: number): Promise<string> {\n    return await new WechatMiniProgramCodeService(this.container, this.env)\n      .createUserSpreadDataUrl(uid) ?? "";\n  }', '  async routineCode(actor: LegacyShareActor): Promise<string> {\n    return new LegacyShareCodeService(this.container, this.env).routineCode(actor);\n  }'],
    ],
  },
  {
    path: 'workers-ts/src/controllers/api/v1/UserProfileController.ts',
    replacements: [
      ['import { UserSpreadPosterDataService } from "@/services/user/UserSpreadPosterDataService";', 'import { UserSpreadPosterDataService } from "@/services/user/UserSpreadPosterDataService";\nimport { assertLegacyShareActor, type LegacyShareActor } from "@/services/other/LegacyShareCodeService";\nimport { enforceLegacyShareBudget } from "@/services/other/LegacyShareBudget";'],
      ['/** GET /api/user/routine_code — cached WeChat mini-program spread code. */\nexport async function routineCode(c: C) {\n  return response(c, async () => ({ url: await service(c).routineCode(uid(c)) }));\n}', '/** GET /api/user/routine_code — signed mini-program spread image for the current user. */\nexport async function routineCode(c: C) {\n  privateCodeResponse(c);\n  c.header("Pragma", "no-cache");\n  if (new URL(c.req.url).searchParams.size) throw new ValidateException("分销小程序码接口不接受查询参数");\n  const actor: LegacyShareActor = { uid: uid(c), authVersion: c.get("socketAuthVersion") ?? "", expiresAt: c.get("socketTokenExp") ?? 0 };\n  assertLegacyShareActor(actor);\n  await enforceLegacyShareBudget(c.env, c.req.header("CF-Connecting-IP"));\n  return response(c, async () => ({ url: await service(c).routineCode(actor) }));\n}'],
    ],
  },
];
const prepared = changes.map(change => {
  const bytes = fs.readFileSync(path.join(source, change.path));
  const prior = fs.readFileSync(path.join(local, change.path));
  if (hash(bytes) !== hash(prior)) throw Error('Local baseline differs from actual current Source: ' + change.path);
  const original = bytes.toString('utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let candidate = original.replaceAll('\r\n', '\n');
  for (const [from, to] of change.replacements) {
    if (candidate.split(from).length !== 2) throw Error('Expected exactly one anchor: ' + change.path);
    candidate = candidate.replace(from, to);
  }
  candidate = candidate.replaceAll('\n', eol);
  return { ...change, beforeSha256: hash(bytes), candidate: Buffer.from(candidate), originalBytes: bytes };
});
for (const item of prepared) {
  if (hash(fs.readFileSync(path.join(source, item.path))) !== item.beforeSha256 || hash(fs.readFileSync(path.join(local, item.path))) !== item.beforeSha256) throw Error('Guard changed before local candidate write');
}
for (const item of prepared) fs.writeFileSync(path.join(local, item.path), item.candidate);
const receipt = { at: new Date().toISOString(), localOnly: true, sourceWritten: false, source, local, rows: prepared.map(item => ({ path: item.path, sourceBaselineSha256: item.beforeSha256, localBeforeSha256: item.beforeSha256, localCandidateSha256: hash(item.candidate), localAfterSha256: hash(fs.readFileSync(path.join(local, item.path))), sourceAfterSha256: hash(fs.readFileSync(path.join(source, item.path))) })) };
fs.writeFileSync(path.join(root, 'user-routine-candidate-local-prepare.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
