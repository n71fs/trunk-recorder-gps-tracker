#!/usr/bin/env python3
"""Collect licenses for Go dependencies used by any shipped platform."""
import json,os,pathlib,subprocess
binary=os.environ.get('GO_BINARY','go');decoder=json.JSONDecoder();modules={}
for system,arch in [('linux','amd64'),('linux','arm64'),('darwin','amd64'),('darwin','arm64'),('windows','amd64')]:
 env={**os.environ,'GOOS':system,'GOARCH':arch,'CGO_ENABLED':'0'}
 text=subprocess.check_output([binary,'list','-deps','-json','.'],env=env,text=True,encoding='utf-8')
 while text.strip():
  obj,end=decoder.raw_decode(text.lstrip());text=text.lstrip()[end:];m=obj.get('Module')
  if m and not m.get('Main'):modules[m['Path']]=m
root=pathlib.Path(subprocess.check_output([binary,'env','GOROOT'],text=True,encoding='utf-8').strip())
parts=['Third-party notices for GPS history\n\nApplication source: GPL-3.0-or-later (see LICENSE).\nDependency licenses below remain their respective authors’ licenses.\n','Go standard library and runtime\n'+(root/'LICENSE').read_text(encoding='utf-8')]
for name,m in sorted(modules.items()):
 folder=pathlib.Path(m['Dir']);files=sorted({*folder.glob('LICENSE*'),*folder.glob('COPYING*')})
 if not files:raise RuntimeError('Missing license for '+name)
 parts.append('\n'+name+' '+m.get('Version','')+'\n'+'\n'.join(f.name+'\n'+f.read_text(encoding='utf-8',errors='replace') for f in files if f.is_file()))
pathlib.Path('THIRD_PARTY_NOTICES.txt').write_text('\n\n'.join(parts),encoding='utf-8')
print('Collected runtime and '+str(len(modules))+' module licenses')
