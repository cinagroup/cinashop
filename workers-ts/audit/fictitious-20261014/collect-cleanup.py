import pathlib, re, json, datetime, subprocess
base=pathlib.Path('/home/cina/cinagroup/cinashop'); r=base/'workers-ts/audit/fictitious-20261014'; roots={}
for name in ['initial-native.log','corrected-native.log','pre-unit-lock-bound-repair-final-native.log','post-unit-lock-bound-native.log','final-native.log']:
 text=(r/name).read_text(); matches=re.findall(r'FINANCE_LOCAL_STOPPED (/[^\n]+)',text); assert len(matches)==1
 root=matches[0].strip(); assert re.fullmatch(r'/home/cina/cinagroup/cinashop/\.cache/finance-postgres-[A-Za-z0-9]+',root)
 assert root not in roots
 state=subprocess.run([str(base/'.cache/php-ts-tools/pg16/bin/pg_ctl'),'status','-D',root+'/data'],capture_output=True,text=True); assert state.returncode==3
 pid=pathlib.Path(root+'/data/postmaster.pid').exists(); assert not pid
 zero='FINANCE_LOCAL_FIXTURES remaining=0' in text
 roots[root]={'receipt':name,'runnerStopped':True,'pgCtlStatusExit':state.returncode,'pgCtlMessage':state.stdout.strip()+state.stderr.strip(),'postmasterPidExists':False,'originalRunnerRemaining':0 if zero else 1,'currentRemaining':0,'fixtureProof':'original runner0' if zero else 'exact owned offlinecatalogcleanup0 at failed-native-offline-cleanup.json, originalfailure1 retained'}
 if not zero:
  cleanup=json.loads((r/'failed-native-offline-cleanup.json').read_text()); assert cleanup['root']==root and cleanup['remainingFixtureDatabaseCatalogEmpty'] and cleanup['remainingFixtureRoleCatalogEmpty'] and cleanup['exitCode']==0
qa=json.loads(pathlib.Path('/tmp/cinashop-fictitious-qa/attempt-004-cleanup-proof.json').read_text()); assert qa['result']=='ECONNREFUSED' and qa['ownedVitePidAbsent'] and not qa['ownedChromeRemaining'] and qa['browserExit']==0
value={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'Read only pg_ctl status/noPID after original runnerSTOPPED; no restart/connection to inactive clusters; originalfailedcleanup retained and exactofflinecatalogproof used','clusters':roots,'browser':qa,'allOwnedClustersStopped':True,'allOwnedCurrentFixturesCleared':True,'productionOrOtherClustersTouched':False}
(r/'owned-process-cleanup.json').write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n'); print(json.dumps({'stoppedOwnedClusters':len(roots),'currentFixturesRemaining':0,'browserClosed':True,'port4974Closed':True}))
