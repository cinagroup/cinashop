import collections
import datetime
import hashlib
import json
import pathlib
import re

base = pathlib.Path('/home/cina/cinagroup/cinashop')
receipt = base / 'workers-ts/audit/reply-20261014'

def read(name):
    return json.loads((receipt / name).read_text())

def write(name, value):
    (receipt / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def ordinary(name):
    data = read(name)
    assert data['success'] and data['numFailedTests'] == 0
    result = {}
    for file in data['testResults']:
        path = str(pathlib.Path(file['name']).relative_to(base))
        rows = {}
        for case in file['assertionResults']:
            key = path + ' > ' + ' > '.join(case['ancestorTitles'] + [case['title']])
            assert key not in rows
            assert case['status'] in ['passed', 'pending', 'skipped']
            rows[key] = {'status': 'passed' if case['status'] == 'passed' else 'skipped', 'receipt': name}
        result[path] = rows
    return result

def native(name):
    text = re.sub(r'\x1b\[[0-9;]*m', '', (receipt / name).read_text())
    assert 'FINANCE_LOCAL_FIXTURES remaining=0' in text
    assert 'FINANCE_LOCAL_STOPPED ' in text
    result = {}
    for line in text.splitlines():
        match = re.match(r'\s*✓\s+\|regular-unit\| (test/\S+\.test\.ts) > (.*?)\s+\d+(?:\.\d+)?ms\s*$', line)
        if not match:
            continue
        path = 'workers-ts/' + match[1]
        key = path + ' > ' + match[2]
        result.setdefault(path, {})
        assert key not in result[path]
        result[path][key] = {'status': 'passed', 'receipt': name}
    return result

normal = ordinary('pre-json-wire-repair-final-ordinary.json')
normal_post = ordinary('post-json-ordinary.json')
assert len(normal) == 35 and len(normal_post) == 4
normal.update(normal_post)
real = native('pre-json-wire-repair-final-native.log')
real_post = native('post-json-native.log')
assert len(real) == 19 and len(real_post) == 3
real.update(real_post)
normal_flat = {k: v for rows in normal.values() for k, v in rows.items()}
real_flat = {k: v for rows in real.values() for k, v in rows.items()}
passed = {k for k, v in normal_flat.items() if v['status'] == 'passed'}
skipped = {k for k, v in normal_flat.items() if v['status'] == 'skipped'}
native_passed = set(real_flat)
assert (len(passed), len(skipped), len(native_passed), len(passed & native_passed), len(passed | native_passed)) == (307, 86, 231, 145, 393)
assert skipped <= native_passed
write('verification-summary.json', {
    'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'method': 'Identity is repository-relative full test file plus ancestor titles plus case title; replace all definitions in each rerun full file, then union ordinary passed and native passed. Loops inside a test are not additional definitions.',
    'singleFinalFullMatrix': False,
    'ordinary': {'files': len(normal), 'filesWithPassedDefinitions': sum(any(v['status'] == 'passed' for v in rows.values()) for rows in normal.values()), 'passed': len(passed), 'skipped': len(skipped), 'failed': 0},
    'native': {'files': len(real), 'passed': len(native_passed), 'skipped': 0, 'failed': 0},
    'overlap': len(passed & native_passed), 'uniquePassed': len(passed | native_passed),
    'allConditionalSupplemented': skipped <= native_passed,
    'supplementedConditional': len(skipped & native_passed),
    'replacement': {'ordinaryFullFiles': sorted(normal_post), 'nativeFullFiles': sorted(real_post), 'baselineOrdinary': 'pre-json-wire-repair-final-ordinary.json', 'baselineNative': 'pre-json-wire-repair-final-native.log', 'latestOrdinary': 'post-json-ordinary.json', 'latestNative': 'post-json-native.log'},
    'ordinaryDefinitions': normal_flat, 'nativeDefinitions': real_flat,
})
frozen = read('frozen-before.json')
directories = ['workers-ts/src', 'workers-ts/test', 'workers-ts/scripts', 'workers-ts/migrations', 'view/admin-ts/src', 'view/admin-ts/public', 'view/supplier-ts/src', 'view/supplier-ts/public']
actual_inventory = {str(p.relative_to(base)) for directory in directories for p in (base / directory).rglob('*') if p.is_file()}
declared_inventory = {p for p in frozen['files'] if any(p.startswith(d + '/') for d in directories)}
assert actual_inventory == declared_inventory
current = {p: hashlib.sha256((base / p).read_bytes()).hexdigest() for p in frozen['files']}
assert current == frozen['files']
digest = hashlib.sha256(json.dumps(current, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
assert digest == frozen['digest'] and len(current) == 3348
write('frozen-after.json', {**frozen, 'files': current, 'recomputedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'declaredDirectoriesInventoryComplete': True, 'declaredDirectories': directories, 'allHashesMatchBefore': True})
print(json.dumps({'ordinaryPassed': len(passed), 'ordinarySkipped': len(skipped), 'nativePassed': len(native_passed), 'overlap': len(passed & native_passed), 'uniquePassed': len(passed | native_passed), 'allConditionalSupplemented': True, 'frozenCount': len(current), 'digest': digest}))
