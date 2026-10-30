/** PC footer-only comparison rules adapted from php-src/php-8.0.5
 * Zend/zend_operators.c (zendi_smart_strcmp, _is_numeric_string_ex) and
 * Zend/zend_hash.c (unordered zend_hash_compare_impl).
 * Copyright (c) Zend Technologies Ltd. (http://www.zend.com).
 * Original authors: Andi Gutmans, Zeev Suraski, Dmitry Stogov.
 * Source: https://github.com/php/php-src/tree/php-8.0.5/Zend
 *
 * --------------------------------------------------------------------
 *                 The Zend Engine License, Version 2.00
 * Copyright (c) 1999-2006 Zend Technologies Ltd. All rights reserved.
 * --------------------------------------------------------------------
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, is permitted provided that the following conditions
 * are met:
 *
 *   1. Redistributions of source code must retain the above copyright
 *      notice, this list of conditions and the following disclaimer.
 *
 *   2. Redistributions in binary form must reproduce the above
 *      copyright notice, this list of conditions and the following
 *      disclaimer in the documentation and/or other materials provided
 *      with the distribution.
 *
 *   3. The names "Zend" and "Zend Engine" must not be used to endorse
 *      or promote products derived from this software without prior
 *      permission from Zend Technologies Ltd. For written permission,
 *      please contact license@zend.com.
 *
 *   4. Zend Technologies Ltd. may publish revised and/or new versions
 *      of the license from time to time. Each version will be given a
 *      distinguishing version number.
 *      Once covered code has been published under a particular version
 *      of the license, you may always continue to use it under the
 *      terms of that version. You may also choose to use such covered
 *      code under the terms of any subsequent version of the license
 *      published by Zend Technologies Ltd. No one other than Zend
 *      Technologies Ltd. has the right to modify the terms applicable
 *      to covered code created under this License.
 *
 *   5. Redistributions of any form whatsoever must retain the following
 *      acknowledgment:
 *      "This product includes the Zend Engine, freely available at
 *      http://www.zend.com"
 *
 *   6. All advertising materials mentioning features or use of this
 *      software must display the following acknowledgment:
 *      "The Zend Engine is freely available at http://www.zend.com"
 *
 * THIS SOFTWARE IS PROVIDED BY ZEND TECHNOLOGIES LTD. ``AS IS'' AND
 * ANY EXPRESSED OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
 * PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL ZEND
 * TECHNOLOGIES LTD.  BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF
 * USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
 * OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 *
 * --------------------------------------------------------------------
 */
import type { PcBaseFiling, PcBaseLink } from '../../../../view/common/pcBase';
import { php8FooterSort } from './Php8FooterSort';

type FooterRow = PcBaseLink | PcBaseFiling;
type NumericString = { kind: 'long'; integer: bigint; value: number; overflow: 0 }
  | { kind: 'double'; value: number; overflow: -1 | 0 | 1 };
const INT64_MIN = -(1n << 63n), INT64_MAX = (1n << 63n) - 1n;
const encoder = new TextEncoder();
const sign = (value: number) => value > 0 ? 1 : value < 0 ? -1 : 0;

/** Locale-free PHP binary string order over the UTF-8 stored JSON text. JS
 * UTF-16 relational order differs for supplementary-plane characters. */
export function pcFooterUtf8Compare(left: string, right: string): number {
  if (left === right) return 0;
  const a = encoder.encode(left), b = encoder.encode(right), length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) if (a[index] !== b[index]) return sign(a[index]! - b[index]!);
  return sign(a.length - b.length);
}

/** PHP8 numeric strings, 64-bit zend_long and binary64 zend_strtod. BigInt is
 * used only for the in-range integer path; floats intentionally retain PHP's
 * finite precision. See official php-src/php-8.0.5 Zend/zend_operators.c:
 * _is_numeric_string_ex and zendi_smart_strcmp. */
function numericString(source: string): NumericString | null {
  const value = source.replace(/^[\x09-\x0d ]+|[\x09-\x0d ]+$/gu, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(value)) return null;
  const direction = value.startsWith('-') ? -1 : 1;
  if (/^[+-]?\d+$/u.test(value)) {
    const integer = BigInt(value);
    if (integer >= INT64_MIN && integer <= INT64_MAX) return { kind: 'long', integer, value: Number(integer), overflow: 0 };
    return { kind: 'double', value: Number(value), overflow: direction };
  }
  // Zend stops the integer scan after 20 significant leading digits and sets
  // overflow before strtod sees any following decimal point or exponent.
  const prefix = /^[+-]?(\d*)/u.exec(value)![1]!.replace(/^0+/u, '');
  return { kind: 'double', value: Number(value), overflow: prefix.length >= 20 ? direction : 0 };
}

export function pcFooterPhpStringCompare(left: string, right: string): number {
  if (left === right) return 0;
  const a = numericString(left), b = numericString(right);
  if (!a || !b) return pcFooterUtf8Compare(left, right);
  if (a.kind === 'long' && b.kind === 'long') return a.integer > b.integer ? 1 : a.integer < b.integer ? -1 : 0;
  // The overflow fallbacks compare original bytes, including signs/zeroes;
  // replacing them with arbitrary-precision decimal order changes PHP.
  if (a.overflow !== 0 && a.overflow === b.overflow && a.value - b.value === 0) return pcFooterUtf8Compare(left, right);
  if (a.kind === 'long' && b.overflow !== 0) return -b.overflow;
  if (b.kind === 'long' && a.overflow !== 0) return a.overflow;
  if (a.value === b.value && !Number.isFinite(a.value)) return pcFooterUtf8Compare(left, right);
  return sign(a.value - b.value);
}

/** Match only the scalar types of independently validated PC footer rows.
 * This is not a general PHP value comparator or a validation/authority gate. */
function scalarCompare(left: unknown, right: unknown): number {
  if (typeof left === 'string' && typeof right === 'string') return pcFooterPhpStringCompare(left, right);
  if (typeof left === 'number' && typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right)) return sign(left - right);
  throw Error('PC页脚排序需要已校验的同类型字段');
}

/** The final array_multisort argument is an ASC/SORT_REGULAR row comparison.
 * zend_compare_arrays uses unordered hash comparison: visit the left row's
 * original insertion order and look up each same key in the right row. */
export function comparePcFooterRows(left: FooterRow, right: FooterRow): number {
  const a = left as unknown as Record<string, unknown>, b = right as unknown as Record<string, unknown>;
  const keys = Object.keys(a), size = sign(keys.length - Object.keys(b).length);
  if (size) return size;
  for (const key of keys) {
    if (!Object.hasOwn(b, key)) return 1;
    const order = scalarCompare(a[key], b[key]);
    if (order) return order;
  }
  return 0;
}

/** The fixed PHP company endpoint sorts numeric sort DESC, URL ASC, then the
 * entire row ASC. Safe URL strings are nonnumeric, including optional ''.
 * Only a fully equal comparison falls through to the original position. */
export function sortedPcFooterRows<T extends FooterRow>(rows: readonly T[]): T[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  php8FooterSort(indexed, (a, b) =>
    sign(b.row.sort - a.row.sort) || pcFooterPhpStringCompare(a.row.url, b.row.url)
    || comparePcFooterRows(a.row, b.row) || a.index - b.index);
  return indexed.map(item => item.row);
}

/** Call only after exact shared footer-field validation. Take keys from the
 * parsed source, values solely from the normalized safe rows. No raw value,
 * extra field, object alias, SQL provenance or preservation proof is exposed. */
export function retainPcFooterKeyOrder<T extends FooterRow>(source: unknown, safe: readonly T[]): T[] {
  if (!Array.isArray(source) || source.length !== safe.length) throw Error('PC页脚安全投影行数不一致');
  return safe.map((row, index) => {
    const original: unknown = source[index];
    if (!original || typeof original !== 'object' || Array.isArray(original)) throw Error('PC页脚安全投影来源无效');
    const keys = Object.keys(original), normalized = row as unknown as Record<string, unknown>;
    if (keys.length !== Object.keys(row).length || keys.some(key => !Object.hasOwn(normalized, key))) throw Error('PC页脚安全投影字段不一致');
    return Object.fromEntries(keys.map(key => [key, normalized[key]])) as unknown as T;
  });
}
