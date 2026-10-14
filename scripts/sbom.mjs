#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=await realpath(fileURLToPath(new URL('../',import.meta.url)));
const args=process.argv.slice(2);
if(args.length!==0&&(args.length!==2||args[0]!=='--out'))throw new Error('Usage: node scripts/sbom.mjs [--out NEW_FILE]');
const pkg=JSON.parse(await readFile(path.join(root,'packages/murmur/package.json'),'utf8'));
const output=path.resolve(args[1]??path.join(root,'dist',`${pkg.name}-${pkg.version}.cdx.json`));
const {stdout}=await promisify(execFile)('npm',['sbom','--omit=dev','--workspace=packages/murmur','--sbom-format=cyclonedx','--offline','--ignore-scripts'],{cwd:root,timeout:60000,maxBuffer:16*1024*1024});
const bom=JSON.parse(stdout);
if(bom.bomFormat!=='CycloneDX'||!Array.isArray(bom.components)||!bom.components.some(c=>c.purl===`pkg:npm/${pkg.name}@${pkg.version}`&&c.version===pkg.version))throw new Error('npm did not produce the expected runtime SBOM');
await mkdir(path.dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(bom,null,2)+'\n',{flag:'wx',mode:0o644});
console.log(JSON.stringify({file:output,format:bom.bomFormat,specVersion:bom.specVersion,components:bom.components.length,source:'npm installed dependency graph',advisoryScan:false}));
