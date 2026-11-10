import { randomInt } from 'node:crypto';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '01234567890123456789012345';

function shuffled(text, randomIndex) {
  const values = [...text];
  for (let index = values.length - 1; index > 0; index--) {
    const selected = randomIndex(index + 1);
    if (!Number.isSafeInteger(selected) || selected < 0 || selected > index) {
      throw new Error('Invalid generated canary permutation index');
    }
    [values[index], values[selected]] = [values[selected], values[index]];
  }
  return values;
}

/** Generate a fresh probe within the pinned generic-api-key rule's domain.
 * Arbitrary base64url can contain no digits or a default stopword, and is then
 * intentionally exempted by Gitleaks 8.29.0. Two independently shuffled blocks
 * retain fixed character counts/entropy and alternate letters with digits;
 * no alphabet-only value or dictionary substring can occur. No scanner retry.
 * Rule: https://github.com/gitleaks/gitleaks/blob/v8.29.0/cmd/generate/config/rules/generic.go
 */
export function createGenericKeyCanary(randomIndex = randomInt) {
  let value = '';
  for (let block = 0; block < 2; block++) {
    const letters = shuffled(LETTERS, randomIndex), digits = shuffled(DIGITS, randomIndex);
    for (let index = 0; index < letters.length; index++) value += letters[index] + digits[index];
  }
  return value;
}
