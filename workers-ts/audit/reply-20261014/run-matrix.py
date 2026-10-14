import sys,json,subprocess
from pathlib import Path
root=Path(__file__).resolve().parent
for c in json.loads((root/'final-commands.json').read_text()):
 print('START '+c['name'],flush=True)
 code=subprocess.call([sys.executable,str(root/'run-check.py'),c['name'],*c['args']],cwd=c['cwd'])
 print('FINISH '+c['name']+' exit='+str(code),flush=True)
 if code:sys.exit(code)
