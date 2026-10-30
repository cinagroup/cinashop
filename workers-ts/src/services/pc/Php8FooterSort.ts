/** PC footer-only index translation of PHP8 Zend/zend_sort.c. Preserve its
 * comparison direction and call order: PHP's unordered array comparison can
 * be non-antisymmetric for mixed historical JSON key insertion orders.
 * Source: https://raw.githubusercontent.com/php/php-src/php-8.0.5/Zend/zend_sort.c
 * Original authors: Xinchen Hui and Sterling Hughes; Zend Technologies Ltd.
 * The quicksort portion is derived from LLVM libc++ (MIT option below).
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
 *
 * LLVM libc++ MIT license option:
 * Copyright (c) 2009-2012 by the contributors listed at
 * http://llvm.org/svn/llvm-project/libcxx/trunk/CREDITS.TXT
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
export function php8FooterSort<T>(values: T[], compare: (left: T, right: T) => number): void {
  const cmp = (a: number, b: number) => compare(values[a]!, values[b]!);
  const swap = (a: number, b: number) => { const value = values[a]!; values[a] = values[b]!; values[b] = value; };
  const sort2 = (a: number, b: number) => { if (cmp(a, b) > 0) swap(a, b); };
  function sort3(a: number, b: number, c: number): void {
    if (!(cmp(a, b) > 0)) {
      if (!(cmp(b, c) > 0)) return;
      swap(b, c); if (cmp(a, b) > 0) swap(a, b); return;
    }
    if (!(cmp(c, b) > 0)) { swap(a, c); return; }
    swap(a, b); if (cmp(b, c) > 0) swap(b, c);
  }
  function sort4(a: number, b: number, c: number, d: number): void {
    sort3(a, b, c);
    if (cmp(c, d) > 0) { swap(c, d); if (cmp(b, c) > 0) { swap(b, c); if (cmp(a, b) > 0) swap(a, b); } }
  }
  function sort5(a: number, b: number, c: number, d: number, e: number): void {
    sort4(a, b, c, d);
    if (cmp(d, e) > 0) { swap(d, e); if (cmp(c, d) > 0) { swap(c, d); if (cmp(b, c) > 0) { swap(b, c); if (cmp(a, b) > 0) swap(a, b); } } }
  }
  function insert(start: number, count: number): void {
    switch (count) {
      case 0: case 1: return;
      case 2: sort2(start, start + 1); return;
      case 3: sort3(start, start + 1, start + 2); return;
      case 4: sort4(start, start + 1, start + 2, start + 3); return;
      case 5: sort5(start, start + 1, start + 2, start + 3, start + 4); return;
    }
    const end = start + count, sentry = start + 6;
    for (let i = start + 1; i < sentry; i++) {
      let j = i - 1; if (!(cmp(j, i) > 0)) continue;
      while (j !== start) { j--; if (!(cmp(j, i) > 0)) { j++; break; } }
      for (let k = i; k > j; k--) swap(k, k - 1);
    }
    for (let i = sentry; i < end; i++) {
      let j = i - 1; if (!(cmp(j, i) > 0)) continue;
      do {
        j -= 2;
        if (!(cmp(j, i) > 0)) { j++; if (!(cmp(j, i) > 0)) j++; break; }
        if (j === start) break;
        if (j === start + 1) { j--; if (cmp(i, j) > 0) j++; break; }
      } while (true);
      for (let k = i; k > j; k--) swap(k, k - 1);
    }
  }
  function sort(start: number, count: number): void {
    while (true) {
      if (count <= 16) { insert(start, count); return; }
      const end = start + count, offset = Math.floor(count / 2);
      let pivot = start + offset;
      if (count >= 1024) { const delta = Math.floor(offset / 2); sort5(start, start + delta, pivot, pivot + delta, end - 1); }
      else sort3(start, pivot, end - 1);
      swap(start + 1, pivot); pivot = start + 1;
      let i = pivot + 1, j = end - 1;
      partition: while (true) {
        while (cmp(pivot, i) > 0) { i++; if (i === j) break partition; }
        j--; if (j === i) break;
        while (cmp(j, pivot) > 0) { j--; if (j === i) break partition; }
        swap(i, j); i++; if (i === j) break;
      }
      swap(pivot, i - 1);
      if (i - 1 - start < end - i) { sort(start, i - start - 1); start = i; count = end - i; }
      else { sort(i, end - i); count = i - start - 1; }
    }
  }
  sort(0, values.length);
}
