import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

for (const variant of ['a', 'b']) {
  it(`test product ${variant} is self-contained, explicitly labelled and bounded`, async () => {
    const content = await readFile(new URL(`../public/test-media/product-${variant}.svg`, import.meta.url), 'utf8');
    assert.ok(Buffer.byteLength(content) < 4096);
    assert.match(content, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="600" height="600"/);
    assert.match(content, new RegExp(`TEST / ${variant.toUpperCase()}`));
    assert.match(content, /NOT A PRODUCT PHOTO/);
    assert.doesNotMatch(content, /<script|<foreignObject|<image|<use|<style|\bon[a-z]+\s*=|\bhref\s*=|url\s*\(|<!ENTITY|<!DOCTYPE/i);
    assert.doesNotMatch(content.replace('http://www.w3.org/2000/svg', ''), /https?:\/\//i);
  });
}
