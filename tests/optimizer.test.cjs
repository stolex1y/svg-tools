'use strict';
// Developer tests only: node --test tests/optimizer.test.cjs
// The Windows application itself needs no Node.js, Python or npm packages.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const SVG_NS='http://www.w3.org/2000/svg';
class FakeNode {
  constructor(tag,attributes={},text='') {
    this.localName=tag;
    this.nodeType=tag==='#text'?3:1;
    this.namespaceURI=this.nodeType===1?SVG_NS:null;
    this._attrs={...attributes};
    this._text=text;
    this.parentNode=null;
    this.childNodes=[];
  }
  get attributes(){return Object.entries(this._attrs).map(([name,value])=>({name,localName:name,value}));}
  get id(){return this.getAttribute('id')||'';}
  get children(){return this.childNodes.filter(n=>n.nodeType===1);}
  get firstChild(){return this.childNodes[0]||null;}
  get textContent(){return this.nodeType===3?this._text:this.childNodes.map(x=>x.textContent).join('');}
  hasAttribute(key){return Object.prototype.hasOwnProperty.call(this._attrs,key);}
  getAttribute(key){return this._attrs[key]??null;}
  removeAttribute(key){delete this._attrs[key];}
  append(...nodes){
    for(const node of nodes){if(node.parentNode)node.parentNode.removeChild(node);node.parentNode=this;this.childNodes.push(node);}
    return this;
  }
  removeChild(node){
    const i=this.childNodes.indexOf(node);
    if(i<0)throw new Error('Node is not a child');
    this.childNodes.splice(i,1);node.parentNode=null;
  }
  insertBefore(node,marker){
    if(node.parentNode)node.parentNode.removeChild(node);
    const index=this.childNodes.indexOf(marker);
    if(index<0)throw new Error('Invalid insertion marker');
    this.childNodes.splice(index,0,node);node.parentNode=this;
  }
  remove(){if(this.parentNode)this.parentNode.removeChild(this);}
}
const E=(name,attributes={},...children)=>new FakeNode(name,attributes).append(...children);
const T=value=>new FakeNode('#text',{},value);
const D=documentElement=>({documentElement});
function all(doc){
  const found=[];
  function walk(node){for(const child of node.children){found.push(child);walk(child);}}
  walk(doc.documentElement);
  return found;
}
function getRefIds(value){
  return Array.from(value.matchAll(/url\s*\(\s*['"]?#([^)'"]+)['"]?\s*\)/g),m=>m[1]);
}

// Exercise the exact production functions without depending on a browser DOM
// implementation or importing any external testing library.
const source=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const begin=source.indexOf('  function referencedIds(doc) {');
const end=source.indexOf('  async function removeRedundantClips(doc) {',begin);
assert.ok(begin>=0 && end>begin,'Production optimization helpers must be present');
const api=vm.runInNewContext(
  source.slice(begin,end)+'\n({referencedIds,removeUnusedIds,pruneDefinitions,coordinateInventory,coordinatesPreserved,optimizeStructure});',
  {SVG_NS,all,getRefIds}
);

test('unwraps nested attribute-free groups, preserving path data exactly',()=>{
  const precise='M0.0000000000000001 1.2345678901234567L23.000000000000007 2';
  const root=E('svg',{viewBox:'0 0 24.123456789012345 24'},E('g',{},E('g',{},E('path',{d:precise}))));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.flattened,2);
  assert.equal(root.children[0].getAttribute('d'),precise);
});

test('retains styled, referenced and transformed groups',()=>{
  const root=E('svg',{},
    E('g',{transform:'translate(0.00000001,2.123456789)'},E('path',{d:'M0 0L1 1'})),
    E('g',{class:'named'},E('path',{d:'M0 0L2 2'})),
    E('g',{id:'target'},E('path',{d:'M0 0L3 3'})),
    E('use',{href:'#target'}));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.flattened,0);
  assert.equal(root.children.filter(el=>el.localName==='g').length,3);
});

test('drops empty path and whitespace, not valid geometry',()=>{
  const root=E('svg',{},T('\n '),E('g',{},T(' \n ')),E('path',{d:'  '}),E('path',{d:'M0 0L12 12'}));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.emptyPaths,1);
  assert.equal(result.emptyGroups,1);
  assert.equal(result.whitespace,2);
  assert.equal(root.children.length,1);
});

test('retains referenced empty paths',()=>{
  const root=E('svg',{},E('defs',{},E('path',{id:'path1',d:''})),E('use',{href:'#path1'}));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.emptyPaths,0);
  assert.ok(all(D(root)).some(n=>n.id==='path1'));
});

test('removes only explicitly invisible and unreferenced elements',()=>{
  const root=E('svg',{},
    E('path',{d:'M1 1L2 2',display:'none'}),
    E('g',{opacity:'0.000'},E('path',{d:'M2 2L3 3'})),
    E('path',{d:'M4 4L5 5',opacity:'0',style:'opacity:1'}),
    E('path',{d:'M6 6L7 7'}));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.hidden,2);
  assert.equal(root.children.length,2);
  assert.equal(root.children[0].getAttribute('style'),'opacity:1');
});

test('retains explicitly hidden referenced geometry',()=>{
  const root=E('svg',{},
    E('defs',{},E('path',{id:'hiddenPath',display:'none',d:'M1 1L5 5'})),
    E('use',{href:'#hiddenPath'}));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.hidden,0);
  assert.ok(all(D(root)).some(n=>n.id==='hiddenPath'));
});

test('preserves hidden descendants of clip paths and mask definitions',()=>{
  const root=E('svg',{},
    E('defs',{},
      E('clipPath',{id:'clip'},E('path',{d:'M0 0L10 10',opacity:'0'})),
      E('mask',{id:'mask'},E('path',{d:'M1 1L9 9',display:'none'}))),
    E('path',{d:'M0 0L24 24','clip-path':'url(#clip)',mask:'url(#mask)'}));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.hidden,0);
  assert.ok(all(D(root)).some(n=>n.localName==='clipPath'));
  assert.ok(all(D(root)).some(n=>n.localName==='mask'));
});

test('does not restructure when embedded CSS selectors may depend on hierarchy',()=>{
  const root=E('svg',{},T('\n'),E('style',{},T('svg > g path{fill:blue}')),
    E('g',{},E('path',{d:'M0 0L2 2'})),E('path',{d:''}));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.skippedCss,true);
  assert.equal(result.emptyPaths,0);
  assert.equal(result.flattened,0);
  assert.equal(root.childNodes[0].textContent,'\n');
});

test('does not flatten a group inside clipPath',()=>{
  const root=E('svg',{},E('defs',{},E('clipPath',{id:'clip'},E('g',{},E('path',{d:'M1 1L2 2'})))));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.flattened,0);
  assert.ok(all(D(root)).some(n=>n.localName==='g'));
});

test('removes empty class and style while retaining transforms and coordinate strings',()=>{
  const root=E('svg',{},E('g',{class:' ',style:'  '},
    E('path',{d:'M2.000001 4L8 10',transform:'translate(0.000000001,20.000000001)'})));
  const result=api.optimizeStructure(D(root));
  assert.equal(result.emptyAttributes,2);
  assert.equal(result.flattened,1);
  assert.equal(root.children[0].getAttribute('transform'),'translate(0.000000001,20.000000001)');
});

test('coordinate guard rejects rounding of a path',()=>{
  const viewBox='0 0 24.000000000000009 24';
  const before=D(E('svg',{viewBox},E('path',{d:'M0.000000000001 2.5555555555555555L6 8'})));
  const same=D(E('svg',{viewBox},E('path',{d:'M0.000000000001 2.5555555555555555L6 8'})));
  const rounded=D(E('svg',{viewBox},E('path',{d:'M0 2.56L6 8'})));
  assert.equal(api.coordinatesPreserved(before,same),true);
  assert.equal(api.coordinatesPreserved(before,rounded),false);
});

test('coordinate guard rejects changed viewBox or transform',()=>{
  const before=D(E('svg',{viewBox:'0.000000000000001 0 24 24'},E('g',{transform:'translate(0.000000000001,2)'},E('path',{d:'M1 1Z'}))));
  const newViewBox=D(E('svg',{viewBox:'0 0 24 24'},E('g',{transform:'translate(0.000000000001,2)'},E('path',{d:'M1 1Z'}))));
  const newTransform=D(E('svg',{viewBox:'0.000000000000001 0 24 24'},E('g',{transform:'translate(0,2)'},E('path',{d:'M1 1Z'}))));
  assert.equal(api.coordinatesPreserved(before,newViewBox),false);
  assert.equal(api.coordinatesPreserved(before,newTransform),false);
});

test('unused geometry may be deleted, without rewriting surviving coordinates',()=>{
  const before=D(E('svg',{viewBox:'0 0 24 24'},E('path',{d:'M1.234567890123456 1Z'})));
  const after=D(E('svg',{viewBox:'0 0 24 24'}));
  assert.equal(api.coordinatesPreserved(before,after),true);
});
