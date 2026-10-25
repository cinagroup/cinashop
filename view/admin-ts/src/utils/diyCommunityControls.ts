import { navRead } from './diyNavigationEditor';

// Exact array assembly from PHP8ed2a5b c_community.vue (4content+8style cases).
// Whole-source SHA256:6e4250dc590e71a4d0d4137a7924406fca8b3af5791bcfe560cffeef8b5174b6
const content = ['titleLeft', 'styleConfig', 'titleHead', 'titleConfig'];
const contentTail = ['rightBntConfig', 'titleContent', 'numberConfig'];
const titleStyle = ['titleText', 'titleColor', 'titleNumber'];
const commonStyle = ['titleCurrency', 'moduleColor', 'bottomBgColor', 'topConfig', 'bottomConfig', 'prConfig', 'mbConfig', 'fillet'];
export function communityControlKeys(block: unknown): string[] {
  if (navRead(block, ['name']) !== 'community') return [];
  const style = Number(navRead(block, ['styleConfig', 'tabVal'])) === 1;
  const title = Number(navRead(block, ['titleConfig', 'tabVal'])) === 1;
  const custom = Number(navRead(block, ['toneConfig', 'tabVal'])) === 1;
  if (Number(navRead(block, ['setUp', 'tabVal'])) !== 1) return [
    'setUp', ...content, title ? 'titleTxtConfig' : 'imgConfig', ...contentTail, ...(style ? ['selectConfig'] : []),
  ];
  return [
    'setUp', 'titleRight', 'headerBgColor', ...(title ? titleStyle : []),
    'headerBntColor', 'bntNumber', 'titleVideoStyle', style ? 'videoSpace' : 'videoSpace2', 'filletImg',
    ...(style ? ['toneConfig'] : []), ...(style && custom ? ['likeSuccessColor'] : []), ...commonStyle,
  ];
}
