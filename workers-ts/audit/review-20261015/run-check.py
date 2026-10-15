import sys,subprocess,json,datetime,os
from pathlib import Path
name=sys.argv[1];args=sys.argv[2:];root=Path(__file__).resolve().parent
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
receipt={'name':name,'argv':args,'cwd':str(Path.cwd()),'startedAt':now(),'serialWrapperRequired':True}
env=dict(os.environ);env['PATH']='/home/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:'+env.get('PATH','')
with (root/(name+'.log')).open('w') as output:
 code=subprocess.call(['bash','/home/cina/cinagroup/tools/validate-serial.sh',*args],env=env,stdout=output,stderr=subprocess.STDOUT)
receipt.update(completedAt=now(),exitCode=code,log=name+'.log')
(root/(name+'-status.json')).write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(receipt,ensure_ascii=False));sys.exit(code)
