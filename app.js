'use strict';
/* SVG Inspector: offline-first, dependency-free SVG validation and conservative cleanup. */
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_FILES = 100;
  const NO_ELEMENTS = new Set(['script','foreignObject','iframe','object','embed','audio','video','image','a','animate','animateMotion','animateTransform','set','discard','handler']);
  const META_ELEMENTS = new Set(['metadata','title','desc','namedview']);
  const DRAWABLE = new Set(['path','rect','circle','ellipse','polygon','polyline','line','text','use']);
  const DEF_TAGS = new Set(['linearGradient','radialGradient','pattern','filter','clipPath','mask','marker','symbol']);
  const state = {items:[], selected:-1, previewUrl:null, cleanedUrl:null, current:null, busy:false};
  const $ = id => document.getElementById(id);
  const delay = () => new Promise(resolve => setTimeout(resolve,0));
  const bytes = s => new Blob([s]).size;
  const formatBytes = n => n < 1024 ? n + ' Б' : (n / 1024).toFixed(1) + ' КБ';
  const serialize = doc => new XMLSerializer().serializeToString(doc);
  const all = root => Array.from(root.getElementsByTagName('*'));
  const check = (level, title, description) => ({level,title,description});
  const unsafeUrl = value => /url\s*\(\s*(?!['"]?#)[^)]*\)|@import\b|@font-face\b|expression\s*\(|javascript\s*:|https?:\s*\/\/|file\s*:/i.test(value);
  const getRefIds = value => {
    const matches = [];
    const urlPattern = /url\s*\(\s*['"]?#([^)'"]+)['"]?\s*\)/g;
    let m;
    while ((m = urlPattern.exec(value))) matches.push(m[1]);
    return matches;
  };
  const xmlError = doc => doc.getElementsByTagName('parsererror').length > 0;

  function parseSvg(raw) {
    if (/<!DOCTYPE\b|<!ENTITY\b/i.test(raw)) throw new Error('DOCTYPE и XML entities запрещены: они небезопасны для локальной обработки.');
    const doc = new DOMParser().parseFromString(raw,'image/svg+xml');
    if (xmlError(doc)) throw new Error('Ошибка XML: файл повреждён или содержит некорректные теги.');
    if (!doc.documentElement || doc.documentElement.localName !== 'svg') throw new Error('Корневой элемент должен быть <svg>.');
    if (all(doc).length > 10000) throw new Error('SVG содержит слишком много элементов (более 10 000).');
    if (doc.documentElement.namespaceURI !== SVG_NS) {
      // Some editors save no default namespace; reparse with an explicit one.
      const normalized = raw.replace(/<svg\b/i,'<svg xmlns="' + SVG_NS + '"');
      const fixed = new DOMParser().parseFromString(normalized,'image/svg+xml');
      if (xmlError(fixed) || fixed.documentElement.namespaceURI !== SVG_NS) throw new Error('SVG не имеет корректного пространства имён.');
      return fixed;
    }
    return doc;
  }

  // Remove executable, externally referenced and editor-specific content.
  // This is also applied BEFORE making any browser image or Blob URL.
  function sanitize(source) {
    const doc = source.cloneNode(true);
    const changes = {nodes:0,attrs:0,external:0,metadata:0};
    const walker = all(doc);
    for (const el of walker.reverse()) {
      const tag = el.localName;
      if (!el.parentNode) continue;
      const fullName = el.nodeName.toLowerCase();
      if (tag === 'a') {
        // Links are interactive, but their children may be essential visible paths.
        const parent=el.parentNode;
        while (el.firstChild) parent.insertBefore(el.firstChild,el);
        el.remove();changes.nodes++;changes.external++;continue;
      }
      if (NO_ELEMENTS.has(tag) || META_ELEMENTS.has(tag) || /^(?:sodipodi|inkscape):/.test(fullName)) {
        if (META_ELEMENTS.has(tag) || /^(?:sodipodi|inkscape):/.test(fullName)) changes.metadata++;
        else changes.external++;
        el.remove(); changes.nodes++; continue;
      }
      if (tag === 'style' && unsafeUrl(el.textContent || '')) {
        el.remove(); changes.nodes++; changes.external++; continue;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        const badNamespace = /^(?:inkscape:|sodipodi:|xmlns:(?!xlink\b))/.test(name);
        const eventHandler = /^on[a-z]+$/.test(name);
        const externalHref = /^(?:href|xlink:href)$/.test(name) && !/^#[A-Za-z_][\w:.-]*$/.test(value);
        const unsafeContent = (name === 'style' || name === 'filter' || name === 'fill' || name === 'stroke' || name === 'clip-path' || name === 'mask' || name === 'marker-start' || name === 'marker-mid' || name === 'marker-end') && unsafeUrl(value);
        const editorAttr = name === 'data-name' || name === 'data-layer' || name === 'version' || name === 'enable-background' || name.startsWith('data-') || name === 'xml:space';
        const dangerousHref = (name === 'href' || name === 'xlink:href') && value.trim().toLowerCase().startsWith('data:');
        if (badNamespace || eventHandler || externalHref || unsafeContent || editorAttr || dangerousHref) {
          el.removeAttribute(attr.name);
          changes.attrs++;
          if (externalHref || unsafeContent || eventHandler || dangerousHref) changes.external++;
        }
      }
    }
    const root = doc.documentElement;
    root.setAttribute('xmlns',SVG_NS);
    // Remove comments and processing instructions (not visual content).
    const nodes = [doc, ...all(doc)];
    for (const parent of nodes) {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === 8 || node.nodeType === 7) { parent.removeChild(node); changes.nodes++; changes.metadata++; }
      }
    }
    return {doc,changes};
  }

  function makeUrl(doc) {
    return URL.createObjectURL(new Blob([serialize(doc)],{type:'image/svg+xml;charset=utf-8'}));
  }
  function freeUrl(url) {if (url) URL.revokeObjectURL(url);}

  async function raster(doc,size) {
    const url = makeUrl(doc);
    try {
      const image = new Image();
      await new Promise((resolve,reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Браузер не смог отобразить SVG. Возможно, есть некорректная геометрия или CSS.'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d',{willReadFrequently:true});
      if (!ctx) throw new Error('Canvas недоступен.');
      ctx.drawImage(image,0,0,size,size);
      return ctx.getImageData(0,0,size,size).data;
    } finally {freeUrl(url);}
  }

  function pixelDiff(a,b) {
    if (a.length !== b.length) return 1;
    let changed = 0, max = 0;
    for (let i=0;i<a.length;i+=4) {
      const d = Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]),Math.abs(a[i+3]-b[i+3]));
      max = Math.max(max,d);
      if (d > 2) changed++;
    }
    return {fraction:changed/(a.length/4),max};
  }
  async function visualMatch(a,b) {
    let worst = 0;
    for (const size of [96,256,512]) {
      const diff = pixelDiff(await raster(a,size),await raster(b,size));
      worst = Math.max(worst,diff.fraction);
      if (diff.fraction > 0.00005) return {same:false,worst,size};
    }
    return {same:true,worst};
  }

  function luminance(r,g,b) {
    const values = [r,g,b].map(v => {v/=255;return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4;});
    return .2126*values[0]+.7152*values[1]+.0722*values[2];
  }
  function contrast(a,b) {return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
  function stats(pixels,size) {
    let count = 0, weighted = 0, bminX=size,bminY=size,bmaxX=-1,bmaxY=-1;
    let lowWhite = 0, lowDark = 0, lowBlue = 0, lowGold = 0;
    const backgrounds = [[255,255,255],[18,24,36],[70,115,200],[232,190,75]].map(v=>luminance(...v));
    const total = pixels.length/4;
    for (let i=0;i<total;i++) {
      const o=i*4, alpha=pixels[o+3]/255;
      if (alpha <= 0.04) continue;
      const x=i%size,y=Math.floor(i/size);
      bminX=Math.min(bminX,x); bminY=Math.min(bminY,y);
      bmaxX=Math.max(bmaxX,x); bmaxY=Math.max(bmaxY,y);
      count++; weighted+=alpha;
      if (alpha > .45) {
        // Alpha-composite pixels on every background before measuring contrast.
        const bg=[[255,255,255],[18,24,36],[70,115,200],[232,190,75]];
        for (let n=0;n<4;n++) {
          const fg=[0,1,2].map(k=>pixels[o+k]*alpha+bg[n][k]*(1-alpha));
          const c=contrast(luminance(...fg),backgrounds[n]);
          if (c < 2.5) {
            if (n===0) lowWhite++;
            if (n===1) lowDark++;
            if (n===2) lowBlue++;
            if (n===3) lowGold++;
          }
        }
      }
    }
    const area = total || 1;
    return {count,coverage:weighted/area,box:count?{left:bminX,top:bminY,right:bmaxX,bottom:bmaxY}:null,
      weak:[lowWhite,lowDark,lowBlue,lowGold].map(n=>n/Math.max(count,1))};
  }

  function analyze(doc, raw) {
    const root=doc.documentElement, nodes=all(doc), notes=[];
    const shapeCount=nodes.filter(n=>DRAWABLE.has(n.localName) && !n.closest('defs,clipPath,mask,symbol')).length;
    const clipCount=nodes.filter(n=>n.localName==='clipPath').length;
    const activeClips=nodes.filter(n=>n.hasAttribute('clip-path') || /clip-path\s*:/.test(n.getAttribute('style')||'')).length;
    const defs=nodes.filter(n=>n.localName==='defs').length;
    const paths=nodes.filter(n=>n.localName==='path');
    const emptyPaths=paths.filter(n=>!(n.getAttribute('d')||'').trim()).length;
    const malformedPaths=paths.filter(n=>{const d=(n.getAttribute('d')||'').trim();return d && !/^[Mm][\s,0-9.+-]/.test(d);}).length;
    const ids=nodes.map(n=>n.id).filter(Boolean);
    const idSet=new Set(ids);
    const duplicateIds=ids.length-idSet.size;
    const references=new Set();
    for(const node of nodes){
      if(node.localName==='style')for(const id of getRefIds(node.textContent||''))references.add(id);
      for(const a of Array.from(node.attributes)){
        for(const id of getRefIds(a.value))references.add(id);
        if(/^(?:href|xlink:href)$/.test(a.name) && a.value.startsWith('#'))references.add(a.value.slice(1));
      }
    }
    const missingRefs=Array.from(references).filter(id=>!idSet.has(id));
    const unusedIds=nodes.filter(n=>n.hasAttribute('id')&&!referencedIds(doc).has(n.getAttribute('id'))).length;
    const strokes=nodes.filter(n=>n.hasAttribute('stroke') && n.getAttribute('stroke')!=='none').length;
    const effects=nodes.filter(n=>['mask','filter','pattern','text','tspan','style','use'].includes(n.localName)).length;
    const metadata=nodes.filter(n=>META_ELEMENTS.has(n.localName)||/^(?:sodipodi|inkscape):/.test(n.nodeName.toLowerCase())).length;
    const dangerous=nodes.filter(n=>NO_ELEMENTS.has(n.localName)).length;
    const unsafeAttrs=nodes.flatMap(n=>Array.from(n.attributes)).filter(a=>
      /^on[a-z]+$/i.test(a.name) || (/^(href|xlink:href)$/i.test(a.name) && !a.value.startsWith('#')) ||
      (['style','fill','stroke','filter','clip-path'].includes(a.name) && unsafeUrl(a.value))).length;
    const vb=(root.getAttribute('viewBox')||'').trim().split(/[\s,]+/).map(Number);
    const goodVB=vb.length===4 && vb.every(Number.isFinite)&&vb[2]>0&&vb[3]>0;
    notes.push(goodVB?check('ok','viewBox корректен',vb.join(' × ')):
      check('warn','viewBox отсутствует или некорректен','Рекомендуется явная область отображения из четырёх чисел с положительной шириной и высотой.'));
    if (emptyPaths) notes.push(check('warn','Пустые path: '+emptyPaths,'Обнаружены пути без атрибута d: удалите их в векторном редакторе.'));
    if (malformedPaths) notes.push(check('warn','Подозрительные path: '+malformedPaths,'Команды пути обычно должны начинаться с M или m. Проверьте геометрию.'));
    if (duplicateIds) notes.push(check('warn','Повторяющиеся id: '+duplicateIds,'Дублирующиеся идентификаторы могут ломать градиенты, маски и clipPath.'));
    if (unusedIds) notes.push(check('warn','Неиспользуемые id: '+unusedIds,'Эти идентификаторы будут удалены при очистке, если на них не ссылаются другие элементы или стили.'));
    else if (ids.length) notes.push(check('ok','Все id используются','Найденные идентификаторы необходимы для внутренних ссылок или CSS.'));
    if (missingRefs.length) notes.push(check('warn','Отсутствующие ссылки: '+missingRefs.length,'Не найдены определения для: '+missingRefs.slice(0,6).join(', ')+'.'));
    if (shapeCount===0) notes.push(check('error','Не обнаружены видимые геометрические элементы','Иконка может быть пустой или полностью содержаться в defs.'));
    else notes.push(check('ok','Геометрия найдена','Видимых геометрических узлов: '+shapeCount+'.'));
    if (clipCount || activeClips) notes.push(check('warn','clipPath: '+clipCount+', применений: '+activeClips,
      'Удаляем неиспользуемые clipPath; применённые клипы проверяем по пикселям перед удалением.'));
    else notes.push(check('ok','clipPath не обнаружен','Обтравочные контуры не используются.'));
    if (strokes) notes.push(check('warn','Обводки: '+strokes,'При генерации иконочного шрифта обводки могут потребовать преобразования в контуры.'));
    else notes.push(check('ok','Обводки отсутствуют','Видимые формы можно проверить на заливку в превью.'));
    if (effects) notes.push(check('warn','Сложные SVG-эффекты: '+effects,
      'Маски, фильтры, стили, текст и ссылки use могут влиять на отображение и препятствовать полной очистке.'));
    if (metadata) notes.push(check('warn','Метаданные редактора: '+metadata,'Они будут удалены при очистке.'));
    if (dangerous || unsafeAttrs) notes.push(check('warn','Потенциально опасное/внешнее содержимое: '+(dangerous+unsafeAttrs),
      'Скрипты, внешние изображения и подозрительные атрибуты удаляются до предпросмотра.'));
    if (!root.getAttribute('width')&&!root.getAttribute('height')&&!goodVB) notes.push(check('error','Не задан размер иконки','Отсутствуют width, height и корректный viewBox.'));
    if (raw.length>100000) notes.push(check('warn','Крупный SVG-файл','Проверьте, нет ли чрезмерного числа точек и служебных узлов.'));
    return {notes,clipCount,defs};
  }

  async function fullReport(item) {
    if (item.error) return;
    const report=analyze(item.doc,item.raw);
    const safe=sanitize(item.doc);
    item.safe=safe.doc; item.sanitizeInfo=safe.changes;
    item.notes=report.notes.slice();
    try {
      const data=await raster(item.safe,256);
      const s=stats(data,256);item.stats=s;
      if (s.count===0) item.notes.push(check('error','Иконка невидима','При растеризации не найдено непрозрачных пикселей.'));
      else {
        item.notes.push(check('ok','Изображение отображается','Непустое изображение, пикселей с видимой непрозрачностью: '+s.count+'.'));
        const box=s.box;
        const margins=[box.left,box.top,255-box.right,255-box.bottom];
        if (Math.min(...margins)<=1) item.notes.push(check('warn','Рисунок касается края области','Есть риск обрезания контура. Проверьте границы на фоне.'));
        else item.notes.push(check('ok','Есть отступы от краёв','Расстояния до краёв (px при 256×256): '+margins.join(', ')+'.'));
        if (s.coverage<.004) item.notes.push(check('warn','Очень маленькая площадь иконки','Видимая площадь менее 0,4% области. Проверьте масштаб и viewBox.'));
        const labels=['белом','тёмном','синем','жёлтом'];
        for (let k=0;k<4;k++) {
          const pct=Math.round(s.weak[k]*100);
          item.notes.push(check(pct>35?'warn':'ok','Контраст на '+labels[k]+' фоне',
            'Доля слабоконтрастных пикселей (оценка): '+pct+'%. Это автоматическая подсказка, не норматив WCAG.'));
        }
      }
    } catch(e) {item.notes.push(check('error','Ошибка отображения',e.message));}
    item.loading=false;
  }

  function renderNotes(item) {
    const container=$('reportList');container.replaceChildren();
    if (!item){$('reportSummary').className='status';$('reportSummary').textContent='Загрузите иконку.';return;}
    const notes=item.notes||[];
    const errors=notes.filter(n=>n.level==='error').length;
    const warns=notes.filter(n=>n.level==='warn').length;
    const summary=$('reportSummary');
    summary.className='status '+(errors?'error':warns?'warn':'ok');
    summary.textContent=errors?('Обнаружено ошибок: '+errors+', предупреждений: '+warns):warns?('Критических ошибок нет. Предупреждений: '+warns):'Проверки пройдены без замечаний.';
    for (const entry of notes) {
      const box=document.createElement('div');
      box.className='check';box.dataset.level=entry.level;
      const heading=document.createElement('strong');heading.textContent=(entry.level==='ok'?'✓ ':entry.level==='warn'?'⚠ ':'✕ ')+entry.title;
      const p=document.createElement('p');p.className='description';p.textContent=entry.description;
      box.append(heading,p);container.append(box);
    }
  }

  const backgrounds=[
    {name:'Белый',style:'#ffffff'},
    {name:'Тёмный',style:'#121824'},
    {name:'Синий',style:'#4673c8'},
    {name:'Жёлтый',style:'#e8be4b'},
    {name:'Прозрачность',style:null},
    {name:'Свой цвет',custom:true}
  ];
  function renderPreviews(item) {
    const container=$('backgroundGrid');container.replaceChildren();
    if (state.previewUrl) freeUrl(state.previewUrl);
    state.previewUrl=item&&!item.error&&item.safe?makeUrl(item.safe):null;
    backgrounds.forEach(bg=>{
      const tile=document.createElement('div');tile.className='preview';
      const canvas=document.createElement('div');canvas.className='canvas';
      if (bg.style) canvas.style.background=bg.style;
      else if (bg.custom) canvas.style.background=$('customColor').value;
      else canvas.classList.add('checker');
      if(state.previewUrl){const image=document.createElement('img');image.alt='Иконка: '+item.name;image.src=state.previewUrl;canvas.append(image);}
      const caption=document.createElement('div');caption.className='caption';caption.textContent=bg.name;
      tile.append(canvas,caption);container.append(tile);
    });
    const s=item&&item.stats;
    $('visualMetrics').textContent=s?(s.count?'Заполнение холста: '+(s.coverage*100).toFixed(1)+'%. Превью построено из SVG после предварительного удаления небезопасного содержимого.':'Пустой рисунок.'):'Ожидается SVG для предпросмотра.';
  }

  function renderList() {
    $('fileCount').textContent='('+state.items.length+')';
    const list=$('fileList');list.replaceChildren();
    if (!state.items.length){const p=document.createElement('p');p.className='hint';p.textContent='Пока нет загруженных SVG.';list.append(p);return;}
    state.items.forEach((item,i)=>{
      const button=document.createElement('button');button.type='button';button.className='item'+(state.selected===i?' selected':'');
      button.setAttribute('aria-pressed',String(i===state.selected));
      const name=document.createElement('strong');name.textContent=item.name;
      const small=document.createElement('small');
      small.textContent=item.error?'✕ '+item.error:item.loading?'Выполняются проверки…':(item.notes||[]).some(n=>n.level==='error')?'✕ Есть ошибки':(item.notes||[]).some(n=>n.level==='warn')?'⚠ Есть предупреждения':'✓ Проверено';
      button.append(name,small);button.addEventListener('click',()=>select(i));list.append(button);
    });
  }

  function resetClean(){
    state.current=null;freeUrl(state.cleanedUrl);state.cleanedUrl=null;
    $('cleanBtn').disabled=true;$('downloadBtn').disabled=true;$('sourceBtn').disabled=true;
    $('cleanStatus').className='status';$('cleanStatus').textContent='Выберите корректный SVG.';
    $('cleanMetrics').textContent='';
    $('beforeImg').removeAttribute('src');$('afterImg').removeAttribute('src');
  }
  function select(i) {
    state.selected=i;renderList();resetClean();
    const item=state.items[i];
    renderNotes(item);renderPreviews(item);
    if (!item)return;
    if(item.error){$('cleanStatus').className='status error';$('cleanStatus').textContent=item.error;return;}
    if(item.loading)return;
    $('sourceBtn').disabled=false;
    $('beforeImg').src=state.previewUrl;
    const error=(item.notes||[]).some(n=>n.level==='error');
    $('cleanBtn').disabled=error;
    $('cleanStatus').textContent=error?'Исправьте ошибки и загрузите SVG повторно.':'Готово к очистке. Экспорт будет разрешён только после сравнения изображения.';
  }
  async function addFiles(files) {
    const incoming=Array.from(files).filter(f=>f.name.toLowerCase().endsWith('.svg')||f.type==='image/svg+xml');
    if(!incoming.length){alert('Выберите файлы формата SVG.');return;}
    if(state.items.length+incoming.length>MAX_FILES){alert('Не более '+MAX_FILES+' SVG за один сеанс.');return;}
    const start=state.items.length;
    for(const file of incoming){
      const item={name:file.name,raw:'',doc:null,error:null,notes:[],loading:true,stats:null};
      state.items.push(item);
      try {
        if(file.size>MAX_BYTES) throw new Error('Файл превышает ограничение в 2 МБ.');
        item.raw=await file.text();
        item.doc=parseSvg(item.raw);
      } catch(e){item.error=e.message;item.loading=false;item.notes=[check('error','Загрузка не удалась',item.error)];}
    }
    renderList();
    if(state.selected===-1)select(start);
    for(let i=start;i<state.items.length;i++) {
      const item=state.items[i];
      if (!item.error) await fullReport(item);
      renderList();
      if(i===state.selected)select(i);
      await delay();
    }
  }

  // Track local references BEFORE deleting id attributes. Keep the original spelling
  // of referenced IDs: renaming or deleting them can break gradients, clips and CSS.
  function referencedIds(doc) {
    const used=new Set();
    const nodes=all(doc);
    const idrefAttributes=new Set([
      'aria-labelledby','aria-describedby','aria-controls','aria-owns',
      'aria-flowto','aria-details','aria-errormessage','aria-activedescendant',
      'for','headers'
    ]);
    let preserveAllIds=false;
    for(const node of nodes) {
      if (node.localName==='style') {
        const rules=node.textContent||'';
        for(const id of getRefIds(rules)) used.add(id);
        // CSS ID selectors (e.g. #logo { fill: red }) depend on the id attribute.
        // Hex colors may produce false positives; keeping an extra id is safer.
        for(const m of rules.matchAll(/#([A-Za-z_][\w:.-]*)/g)) used.add(m[1]);
        // Arbitrary attribute selectors ([id], [id^="foo"]) and CSS escapes
        // cannot reliably be resolved here; retain IDs in these cases.
        if (/\[\s*id(?=\s|[\]~|^$*=:])/i.test(rules) || /\\/.test(rules)) preserveAllIds=true;
      }
      for(const attr of Array.from(node.attributes)) {
        const name=attr.name.toLowerCase(),value=attr.value.trim();
        if (name==='id') continue;
        for(const id of getRefIds(value)) used.add(id);
        if (/^(?:href|xlink:href)$/.test(name) && value.startsWith('#')) used.add(value.slice(1));
        if (idrefAttributes.has(name)) {
          for(const id of value.split(/\s+/)) if(id) used.add(id);
        }
        // SMIL synchronization references such as "elementId.begin".
        if (name==='begin' || name==='end') {
          for(const m of value.matchAll(/(?:^|[;\s])([A-Za-z_][\w:.-]*)\.(?:begin|end|repeat|click|mouseover|mouseout|focusin|focusout)\b/g)) used.add(m[1]);
        }
      }
    }
    if (preserveAllIds) for(const el of nodes) if(el.hasAttribute('id')) used.add(el.getAttribute('id'));
    return used;
  }

  function removeUnusedIds(doc) {
    const referenced=referencedIds(doc);
    let removed=0,retained=0;
    for(const element of all(doc)) {
      if(!element.hasAttribute('id')) continue;
      if(referenced.has(element.getAttribute('id'))) retained++;
      else {element.removeAttribute('id');removed++;}
    }
    return {removed,retained};
  }
  function pruneDefinitions(doc) {
    let removed=0;
    for(let pass=0;pass<8;pass++){
      const used=referencedIds(doc);
      let count=0;
      for(const defs of all(doc).filter(e=>e.localName==='defs')) {
        for(const child of Array.from(defs.children)) {
          if (child.id && !used.has(child.id)) {child.remove();count++;continue;}
          // An unreferenced clipPath in defs with an id is removed; unknown definitions are kept.
        }
        if(!defs.children.length && !defs.textContent.trim()) {defs.remove();count++;}
      }
      removed+=count;
      if(!count)break;
    }
    return removed;
  }
  async function removeRedundantClips(doc) {
    let removed=0,retained=0;
    const nodes=all(doc).filter(el=>el.hasAttribute('clip-path'));
    for(const el of nodes){
      const old=el.getAttribute('clip-path');
      el.removeAttribute('clip-path');
      let same=false;
      try {
        // Clone with clip restored to compare the exact same SVG.
        const without=doc.cloneNode(true);
        el.setAttribute('clip-path',old);
        const result=await visualMatch(doc,without);
        same=result.same;
      }catch(_){same=false;}
      if(same)removed++;
      else{el.setAttribute('clip-path',old);retained++;}
    }
    retained+=all(doc).filter(el=>/clip-path\s*:/.test(el.getAttribute('style')||'')).length;
    return {removed,retained};
  }

  async function doClean() {
    const item=state.items[state.selected];
    if(!item||item.error||item.loading||state.busy||item.notes.some(n=>n.level==='error'))return;
    state.busy=true;$('cleanBtn').disabled=true;$('downloadBtn').disabled=true;
    const status=$('cleanStatus');status.className='status';status.textContent='Очистка и пиксельное сравнение…';
    await delay();
    try{
      const cleaned=sanitize(item.doc);
      const clips=await removeRedundantClips(cleaned.doc);
      const pruned=pruneDefinitions(cleaned.doc);
      const unusedIds=removeUnusedIds(cleaned.doc);
      const comparison=await visualMatch(item.safe,cleaned.doc);
      if(!comparison.same) {
        status.className='status error';
        status.textContent='Экспорт заблокирован: после очистки изменилось изображение (масштаб '+comparison.size+'×'+comparison.size+').';
        state.current=null;
        $('afterImg').removeAttribute('src');
        return;
      }
      state.current={doc:cleaned.doc,svg:serialize(cleaned.doc),clips,pruned,unusedIds};
      freeUrl(state.cleanedUrl);state.cleanedUrl=makeUrl(cleaned.doc);
      $('afterImg').src=state.cleanedUrl;
      $('downloadBtn').disabled=false;
      status.className='status '+(clips.retained?'warn':'ok');
      status.textContent=clips.retained
        ? 'Сравнение пройдено. Экспорт доступен, но '+clips.retained+' clipPath остаются: удаление изменило бы рисунок.'
        : 'Очистка завершена. Пиксельное сравнение на 96, 256 и 512 px пройдено.';
      $('cleanMetrics').textContent='Исходный размер: '+formatBytes(bytes(item.raw))+
        ' → очищенный: '+formatBytes(bytes(state.current.svg))+
        '. Удалено безопасных clipPath: '+clips.removed+', неиспользуемых узлов defs: '+pruned+
        '. Удалено неиспользуемых id: '+unusedIds.removed+', сохранено нужных id: '+unusedIds.retained+
        '. Удалено служебных/опасных узлов: '+cleaned.changes.nodes+
        '. Проверка выполняется относительно безопасного предпросмотра, не исполняющего внешнее содержимое.';
    }catch(e){
      status.className='status error';status.textContent='Очистку не удалось проверить: '+e.message;
      $('downloadBtn').disabled=true;
    }finally{
      state.busy=false;
      $('cleanBtn').disabled=false;
    }
  }

  function download(filename,content) {
    const url=URL.createObjectURL(new Blob([content],{type:'image/svg+xml;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
    // Some browsers need time to consume the Blob after synthetic download.
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  $('fileInput').addEventListener('change',ev=>{
    addFiles(ev.target.files).catch(err=>alert(err.message));
    ev.target.value='';
  });
  $('selectFiles').addEventListener('click',()=>$('fileInput').click());
  const drop=$('dropZone');
  drop.addEventListener('dragover',ev=>{ev.preventDefault();drop.classList.add('over');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('over'));
  drop.addEventListener('drop',ev=>{ev.preventDefault();drop.classList.remove('over');addFiles(ev.dataTransfer.files).catch(err=>alert(err.message));});
  $('customColor').addEventListener('input',()=> {
    const tiles=$('backgroundGrid').querySelectorAll('.preview .canvas');
    if(tiles.length)tiles[tiles.length-1].style.background=$('customColor').value;
  });
  $('cleanBtn').addEventListener('click',doClean);
  $('downloadBtn').addEventListener('click',()=>{
    const item=state.items[state.selected];
    if(item && state.current)download(item.name.replace(/\.svg$/i,'')+'.clean.svg',state.current.svg);
  });
  $('sourceBtn').addEventListener('click',()=>{
    const item=state.items[state.selected];if(item && item.raw)download(item.name,item.raw);
  });
  window.addEventListener('beforeunload',()=>{
    freeUrl(state.previewUrl);freeUrl(state.cleanedUrl);
  });
  renderPreviews(null);
})();