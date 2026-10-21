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
  get attributes(){return Object.entries(this._attrs).map(([name,value])=>({name,localName:name.split(':').at(-1),value,
    namespaceURI:name.startsWith('xlink:')?'http://www.w3.org/1999/xlink':null}));}
  get id(){return this.getAttribute('id')||'';}
  get children(){return this.childNodes.filter(n=>n.nodeType===1);}
  get firstChild(){return this.childNodes[0]||null;}
  get textContent(){return this.nodeType===3?this._text:this.childNodes.map(x=>x.textContent).join('');}
  hasAttribute(key){return Object.prototype.hasOwnProperty.call(this._attrs,key);}
  getAttribute(key){return this._attrs[key]??null;}
  setAttribute(key,value){this._attrs[key]=value;}
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
  source.slice(begin,end)+'\n({referencedIds,removeUnusedIds,pruneDefinitions,coordinateInventory,coordinatesPreserved,optimizeStructure,normalizeAttributes});',
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

test('migrates legacy links, keeps SVG 2 precedence and removes unused namespace declarations',()=>{
  const root=E('svg',{'xmlns:xlink':'http://www.w3.org/1999/xlink'},
    E('use',{'xlink:href':'#legacy'}),
    E('use',{'xlink:href':'#legacy',href:'#modern'}));
  api.normalizeAttributes(D(root));
  assert.equal(root.children[0].getAttribute('href'),'#legacy');
  assert.equal(root.children[1].getAttribute('href'),'#modern');
  assert.equal(root.children[0].hasAttribute('xlink:href'),false);
  assert.equal(root.children[1].hasAttribute('xlink:href'),false);
  assert.equal(root.hasAttribute('xmlns:xlink'),false);
});

test('retains namespace declarations still used by other attributes',()=>{
  const root=E('svg',{'xmlns:xlink':'http://www.w3.org/1999/xlink'},
    E('rect',{'xlink:title':'label',width:'2',height:'2'}));
  api.normalizeAttributes(D(root));
  assert.equal(root.getAttribute('xmlns:xlink'),'http://www.w3.org/1999/xlink');
});

test('omits only zero positions with equivalent defaults, preserving coordinate guard',()=>{
  const make=()=>E('svg',{x:'0',y:'0px'},
    E('rect',{x:'-0.0',y:'0%',width:'12.123456789',height:'8'}),
    E('use',{x:'0e3',y:'0',href:'#shape'}),
    E('pattern',{x:'0',y:'0'}),
    E('rect',{x:'1',y:'0.000000001'}),
    E('mask',{x:'0',y:'0'}),
    E('filter',{x:'0',y:'0'}),
    E('text',{x:'0',y:'0'},E('tspan',{x:'0',y:'0'})));
  const before=D(make()),after=D(make());
  api.normalizeAttributes(after);
  assert.equal(after.documentElement.hasAttribute('x'),false);
  assert.equal(after.documentElement.hasAttribute('y'),false);
  for(const el of after.documentElement.children.slice(0,3)) {
    assert.equal(el.hasAttribute('x'),false);
    assert.equal(el.hasAttribute('y'),false);
  }
  assert.equal(after.documentElement.children[0].getAttribute('width'),'12.123456789');
  assert.equal(after.documentElement.children[3].getAttribute('x'),'1');
  assert.equal(after.documentElement.children[3].getAttribute('y'),'0.000000001');
  for(const el of after.documentElement.children.slice(4)) {
    assert.equal(el.getAttribute('x'),'0');
    assert.equal(el.getAttribute('y'),'0');
  }
  assert.equal(after.documentElement.children[6].children[0].getAttribute('x'),'0');
  assert.equal(api.coordinatesPreserved(before,after),true);
  after.documentElement.children[0].setAttribute('x','1');
  assert.equal(api.coordinatesPreserved(before,after),false);
});

test('retains legacy links and explicit zero positions when CSS may select their attributes',()=>{
  const root=E('svg',{'xmlns:xlink':'http://www.w3.org/1999/xlink'},
    E('style',{},T('[x] { fill: red }')),
    E('use',{'xlink:href':'#shape',x:'0',y:'0'}));
  api.normalizeAttributes(D(root));
  assert.equal(root.children[1].getAttribute('x'),'0');
  assert.equal(root.children[1].getAttribute('y'),'0');
  assert.equal(root.children[1].getAttribute('xlink:href'),'#shape');
  assert.equal(root.children[1].hasAttribute('href'),false);
  assert.equal(root.hasAttribute('xmlns:xlink'),true);
});
test('removes fill and clip rules only when their effective inherited value matches',()=>{
  const root=E('svg',{'fill-rule':'nonzero','clip-rule':'nonzero'},
    E('g',{'fill-rule':'nonzero','clip-rule':'nonzero'}),
    E('g',{'fill-rule':'evenodd','clip-rule':'evenodd'},
      E('path',{'fill-rule':'evenodd','clip-rule':'evenodd'}),
      E('path',{'fill-rule':'nonzero','clip-rule':'nonzero'})),
    E('path',{'fill-rule':'evenodd','clip-rule':'evenodd'}));
  const report=api.normalizeAttributes(D(root));
  assert.equal(root.hasAttribute('fill-rule'),false);
  assert.equal(root.hasAttribute('clip-rule'),false);
  assert.equal(root.children[0].hasAttribute('fill-rule'),false);
  assert.equal(root.children[0].hasAttribute('clip-rule'),false);
  assert.equal(root.children[1].getAttribute('fill-rule'),'evenodd');
  assert.equal(root.children[1].getAttribute('clip-rule'),'evenodd');
  assert.equal(root.children[1].children[0].hasAttribute('fill-rule'),false);
  assert.equal(root.children[1].children[0].hasAttribute('clip-rule'),false);
  assert.equal(root.children[1].children[1].getAttribute('fill-rule'),'nonzero');
  assert.equal(root.children[1].children[1].getAttribute('clip-rule'),'nonzero');
  assert.equal(root.children[2].getAttribute('fill-rule'),'evenodd');
  assert.equal(root.children[2].getAttribute('clip-rule'),'evenodd');
  assert.equal(report.rules,6);
});

test('retains inherited rules and paints with inline-style or referenced ambiguity',()=>{
  const styled=E('svg',{},
    E('g',{style:'fill: blue'},E('path',{'fill-rule':'nonzero',fill:'black'})),
    E('path',{style:'fill: red','fill-rule':'nonzero',fill:'black'}));
  api.normalizeAttributes(D(styled));
  assert.equal(styled.children[0].children[0].getAttribute('fill-rule'),'nonzero');
  assert.equal(styled.children[0].children[0].getAttribute('fill'),'black');
  assert.equal(styled.children[1].getAttribute('fill-rule'),'nonzero');
  assert.equal(styled.children[1].getAttribute('fill'),'black');

  const referenced=E('svg',{},
    E('defs',{},
      E('g',{id:'shape','fill-rule':'nonzero',fill:'red'},
        E('path',{'fill-rule':'nonzero',fill:'red'})),
      E('path',{id:'direct','clip-rule':'nonzero'})),
    E('use',{href:'#shape'}),
    E('use',{href:'#direct'}),
    E('path',{'fill-rule':'nonzero',fill:'black'}));
  api.normalizeAttributes(D(referenced));
  assert.equal(referenced.children[0].children[0].getAttribute('fill-rule'),'nonzero');
  assert.equal(referenced.children[0].children[0].getAttribute('fill'),'red');
  assert.equal(referenced.children[0].children[0].children[0].getAttribute('fill-rule'),'nonzero');
  assert.equal(referenced.children[0].children[0].children[0].getAttribute('fill'),'red');
  assert.equal(referenced.children[0].children[1].getAttribute('clip-rule'),'nonzero');
  assert.equal(referenced.children[3].hasAttribute('fill-rule'),false);
  assert.equal(referenced.children[3].hasAttribute('fill'),false);
});

test('cleans known inherited presentation defaults without erasing overrides',()=>{
  const root=E('svg',{fill:'red','stroke-linecap':'round','fill-opacity':'0.5',opacity:'0.5'},
    E('g',{fill:'red','stroke-linecap':'round','fill-opacity':'1',opacity:'1'},
      E('path',{fill:'blue','stroke-linecap':'butt','fill-opacity':'1',opacity:'1'})));
  const report=api.normalizeAttributes(D(root));
  assert.equal(root.getAttribute('fill'),'red');
  assert.equal(root.getAttribute('stroke-linecap'),'round');
  assert.equal(root.getAttribute('fill-opacity'),'0.5');
  assert.equal(root.getAttribute('opacity'),'0.5');
  assert.equal(root.children[0].hasAttribute('fill'),false);
  assert.equal(root.children[0].hasAttribute('stroke-linecap'),false);
  assert.equal(root.children[0].getAttribute('fill-opacity'),'1');
  assert.equal(root.children[0].hasAttribute('opacity'),false);
  assert.equal(root.children[0].children[0].getAttribute('fill'),'blue');
  assert.equal(root.children[0].children[0].getAttribute('stroke-linecap'),'butt');
  assert.equal(root.children[0].children[0].hasAttribute('fill-opacity'),false);
  assert.equal(root.children[0].children[0].hasAttribute('opacity'),false);
  assert.equal(report.presentation,5);
});

test('preserves unknown inherited values and removes only literal noninherited defaults',()=>{
  const unknown=E('svg',{'fill-rule':'revert',fill:'var(--paint)'},
    E('path',{'fill-rule':'nonzero',fill:'red'}));
  api.normalizeAttributes(D(unknown));
  assert.equal(unknown.getAttribute('fill-rule'),'revert');
  assert.equal(unknown.getAttribute('fill'),'var(--paint)');
  assert.equal(unknown.children[0].getAttribute('fill-rule'),'nonzero');
  assert.equal(unknown.children[0].getAttribute('fill'),'red');
  const cssWide=E('svg',{'fill-rule':'inherit','clip-rule':'unset',fill:'initial',stroke:'revert-layer'},
    E('path',{'fill-rule':'nonzero','clip-rule':'nonzero',fill:'black',stroke:'none'}));
  api.normalizeAttributes(D(cssWide));
  assert.equal(cssWide.getAttribute('fill-rule'),'inherit');
  assert.equal(cssWide.getAttribute('clip-rule'),'unset');
  assert.equal(cssWide.getAttribute('fill'),'initial');
  assert.equal(cssWide.getAttribute('stroke'),'revert-layer');
  assert.equal(cssWide.children[0].getAttribute('fill-rule'),'nonzero');
  assert.equal(cssWide.children[0].getAttribute('clip-rule'),'nonzero');
  assert.equal(cssWide.children[0].getAttribute('fill'),'black');
  assert.equal(cssWide.children[0].getAttribute('stroke'),'none');

  const root=E('svg',{opacity:'0.5','vector-effect':'non-scaling-stroke'},
    E('path',{opacity:'1','vector-effect':'none'}),
    E('linearGradient',{},E('stop',{'stop-color':'black','stop-opacity':'1'})),
    E('linearGradient',{},E('stop',{style:'stop-color: red','stop-color':'black','stop-opacity':'1'})),
    E('rect',{'stop-color':'black','stop-opacity':'1'}));
  api.normalizeAttributes(D(root));
  assert.equal(root.children[0].hasAttribute('opacity'),false);
  assert.equal(root.children[0].hasAttribute('vector-effect'),false);
  assert.equal(root.children[1].children[0].hasAttribute('stop-color'),false);
  assert.equal(root.children[1].children[0].hasAttribute('stop-opacity'),false);
  assert.equal(root.children[2].children[0].getAttribute('stop-color'),'black');
  assert.equal(root.children[2].children[0].getAttribute('stop-opacity'),'1');
  assert.equal(root.children[3].getAttribute('stop-color'),'black');
  assert.equal(root.children[3].getAttribute('stop-opacity'),'1');
});

test('retains zero pattern coordinates when href supplies a referenced pattern',()=>{
  const root=E('svg',{},E('defs',{},
    E('pattern',{id:'base',x:'5',y:'6'}),
    E('pattern',{href:'#base',x:'0',y:'0'})));
  api.normalizeAttributes(D(root));
  assert.equal(root.children[0].children[0].getAttribute('x'),'5');
  assert.equal(root.children[0].children[1].getAttribute('x'),'0');
  assert.equal(root.children[0].children[1].getAttribute('y'),'0');
});

test('preserves explicit root color but removes an identical inherited color',()=>{
  const root=E('svg',{color:'black'},E('path',{color:'black',fill:'currentColor'}));
  api.normalizeAttributes(D(root));
  assert.equal(root.getAttribute('color'),'black');
  assert.equal(root.children[0].hasAttribute('color'),false);
  assert.equal(root.children[0].getAttribute('fill'),'currentColor');
});
