#!/usr/bin/env python3
"""Package a native executable exactly as the TR Pro plugin installer expects."""
import argparse,json,pathlib,tarfile,zipfile
p=argparse.ArgumentParser();p.add_argument('--binary',required=True);p.add_argument('--target',required=True);p.add_argument('--manifest',required=True);p.add_argument('--out',default='dist');a=p.parse_args()
m=json.loads(pathlib.Path(a.manifest).read_text());assert m['api']==1 and m['id']=='gps-history'
name=f"{m['id']}-{m['version']}-{a.target}";root=pathlib.Path(__file__).resolve().parent.parent;out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
files=[(pathlib.Path(a.binary),m['id']+('.exe' if 'windows' in a.target else '')),(root/'README.md','README.md'),(root/'LICENSE','LICENSE'),(root/'THIRD_PARTY_NOTICES.txt','THIRD_PARTY_NOTICES.txt'),(pathlib.Path(a.manifest),'manifest.json')]
if 'windows' in a.target:
 with zipfile.ZipFile(out/(name+'.zip'),'w',zipfile.ZIP_DEFLATED) as z:
  for source,filename in files:z.write(source,f'{name}/{filename}')
else:
 with tarfile.open(out/(name+'.tar.gz'),'w:gz') as z:
  for source,filename in files:
   info=z.gettarinfo(str(source),f'{name}/{filename}')
   if filename==m['id']:info.mode=0o755
   with source.open('rb') as f:z.addfile(info,f)
print(out/name)
