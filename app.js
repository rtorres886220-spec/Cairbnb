const SOURCE_CSV = 'https://seshat.datasd.org/stro_licenses/stro_licenses_datasd.csv';
const STORAGE_KEY = 'turnover-sd-leads-v1';
const MAX_CSV_BYTES = 25 * 1024 * 1024;
const MAX_CSV_ROWS = 60000;
const MAX_LEADS = 50000;
const PAGE_SIZE = 100;
const STATUS = { new: 'New lead', contacted: 'Contacted', replied: 'Replied', won: 'Won', not_fit: 'Not a fit' };
let leadStorageUnavailable = false;
let leadStorageMode = 'local';
let leadDBPromise;
let leads = [];
let selectedId = null;
let toastTimer;
let currentPage = 1;

function sanitizeLeads(stored) {
  return Array.isArray(stored) ? stored.slice(0, MAX_LEADS).filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(x => {
    const clean = {};
    for (const field of ['id','name','phone','email','contactLink','address','listing','area','zip','tier','expiry','notes','followup','source']) clean[field] = String(x[field] ?? '').slice(0, field === 'notes' ? 10000 : 1000);
    clean.status = Object.hasOwn(STATUS, x.status) ? x.status : 'new';
    return clean;
  }).filter(x => x.id) : [];
}
function loadLocalLeads() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return sanitizeLeads(stored);
  } catch { leadStorageUnavailable = true; return []; }
}
function openLeadDB() {
  if (!leadDBPromise) leadDBPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB is not available')); return; }
    const request = indexedDB.open('cairbnb-leads-v1', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('leads')) request.result.createObjectStore('leads', {keyPath: 'id'}); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open lead storage'));
    request.onblocked = () => reject(new Error('Lead storage is blocked by another tab'));
  });
  return leadDBPromise;
}
function readAllLeadRecords(database) {
  return new Promise((resolve, reject) => {
    const request = database.transaction('leads', 'readonly').objectStore('leads').getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not read saved leads'));
  });
}
function putLeadRecords(database, records) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('leads', 'readwrite');
    const store = transaction.objectStore('leads');
    for (const record of records) store.put(record);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error || new Error('Could not save leads'));
    transaction.onabort = () => reject(transaction.error || new Error('Lead save was cancelled'));
  });
}
async function loadLeads() {
  const local = loadLocalLeads();
  try {
    const database = await openLeadDB();
    const stored = await readAllLeadRecords(database);
    leadStorageMode = 'indexeddb';
    leadStorageUnavailable = false;
    if (stored.length) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* IndexedDB is now the authoritative copy. */ }
      return sanitizeLeads(stored);
    }
    if (local.length) {
      await putLeadRecords(database, local);
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* Keep the migrated copy even if cleanup is blocked. */ }
    }
    return local;
  } catch {
    leadStorageMode = 'local';
    return local;
  }
}
async function persist(next = leads, changed = next) {
  if (leadStorageMode === 'indexeddb') {
    try { const database = await openLeadDB(); await putLeadRecords(database, changed); return true; }
    catch { toast('Could not save your leads to this browser. Check available storage and try again.'); return false; }
  }
  if (leadStorageUnavailable) { toast('Browser storage is unavailable. Enable site storage before importing or saving leads.'); return false; }
  try {
    const serialized = JSON.stringify(next);
    if (serialized.length > 1_200_000) throw new Error('storage limit');
    localStorage.setItem(STORAGE_KEY, serialized);
    return true;
  } catch {
    toast('Browser storage is full or unavailable. Export your leads or remove some records, then try again.');
    return false;
  }
}
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function key(row, ...names) {
  const normal = Object.fromEntries(Object.entries(row).map(([k,v]) => [k.toLowerCase().replace(/[^a-z0-9]/g,''), v]));
  for (const name of names) { const v = normal[name.toLowerCase().replace(/[^a-z0-9]/g,'')]; if (v != null && String(v).trim()) return String(v).trim(); }
  return '';
}
function normalize(row) {
  const listing=key(row,'listing_name','listing_title','property_name','title');
  const address=key(row,'address','property_address','street_address','full_address','location')||listing;
  const name=key(row,'local_contact_contact_name','local_contact_name','host_contact_name','host_name','host_full_name','host','name')||'Rental contact';
  const phone=key(row,'local_contact_phone','contact_phone','host_phone','phone_number','phone');
  const email=key(row,'host_email','email_address','email','e_mail');
  const contactLink=key(row,'host_profile_url','host_url','listing_url','airbnb_url','profile_url','website');
  const license=key(row,'license_id','license','listing_id','property_id','id');
  const area=key(row,'community_planning_area','community_area','neighborhood','neighbourhood','city','market')||'San Diego';
  const zip=key(row,'zip','zipcode','postal_code','zip_code');
  const id=license||`${address}|${email||phone}`;
  return {id,name,phone,email,contactLink,address,listing,area,zip,tier:key(row,'tier','license_tier'),expiry:key(row,'date_expiration','expiration_date','license_expiration'),status:'new',notes:'',followup:'',source:'Imported CSV'};
}
function parseCSV(text) {
  if (typeof text !== 'string' || text.length > MAX_CSV_BYTES) throw new Error('CSV is larger than the 25 MB import limit.');
  const rows=[]; let row=[], field='', quoted=false,totalCells=0;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}
    else if(c==='"')quoted=true;
    else if(c===','){if(row.length>=200)throw new Error('CSV has too many columns.');row.push(field);totalCells++;field='';}
    else if(c==='\n'){row.push(field);totalCells++;rows.push(row);if(rows.length>MAX_CSV_ROWS)throw new Error('CSV exceeds the 60,000 row import limit.');if(totalCells>1000000)throw new Error('CSV has too many cells to import safely.');row=[];field='';}
    else if(c!=='\r')field+=c;
    if(field.length>16000)throw new Error('A CSV cell is too large to import.');
  }
  if(field.length||row.length){row.push(field);totalCells++;rows.push(row);}
  if(quoted)throw new Error('CSV has an unclosed quoted field.');
  if(rows.length>MAX_CSV_ROWS)throw new Error('CSV exceeds the 60,000 row import limit.');
  if(totalCells>1000000)throw new Error('CSV has too many cells to import safely.');
  if(rows.length<2)return [];
  const headers=rows.shift().map(h=>h.trim().replace(/^\uFEFF/,''));
  if(headers.length>200)throw new Error('CSV has too many columns.');
  return rows.filter(r=>r.some(v=>v.trim())).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||''])));
}
async function addRows(rows) {
  const normalized=rows.map(normalize).filter(x=>x.id&&(x.address||x.email||x.phone));
  const existing=new Map(leads.map(x=>[x.id,x])),originalIds=new Set(leads.map(x=>x.id)),changed=[];
  let added=0;
  for(const lead of normalized){
    const old=existing.get(lead.id);
    if(old){ const merged={...lead,...old, name:lead.name||old.name, phone:lead.phone||old.phone, email:lead.email||old.email, address:lead.address||old.address, area:lead.area||old.area, tier:lead.tier||old.tier, expiry:lead.expiry||old.expiry};existing.set(lead.id,merged);changed.push(merged); }
    else { existing.set(lead.id,lead);changed.push(lead);added++; }
  }
  const merged=[...existing.values()],next=merged.slice(0,MAX_LEADS);
  const included=new Set(next.map(x=>x.id));if(!await persist(next,changed.filter(x=>included.has(x.id))))return;
  const actuallyAdded=next.filter(x=>!originalIds.has(x.id)).length,omitted=merged.length-next.length;
  leads=next;currentPage=1;render();toast(`${actuallyAdded} new lead${actuallyAdded===1?'':'s'} imported · ${Math.max(0,normalized.length-added)} already saved${omitted?` · ${omitted} beyond the ${MAX_LEADS.toLocaleString()}-lead limit were skipped`:''}`);
}
function toast(message){const el=document.getElementById('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3000);}
function friendlyDate(value){if(!value)return '—'; const d=new Date(`${value}T00:00:00`); return Number.isNaN(d.getTime())?esc(value):d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}
function expiring(value){if(!value)return false;const d=new Date(`${value}T00:00:00`);const days=(d-new Date())/86400000;return days>=0&&days<60;}
function initials(name){return (name||'').split(/\s+/).slice(0,2).map(s=>s[0]||'').join('').toUpperCase();}
function render(){
  const areas=[...new Set(leads.map(x=>x.area).filter(Boolean))].sort();const areaSelect=document.getElementById('areaFilter');const currentArea=areaSelect.value;
  areaSelect.innerHTML='<option value="">All neighborhoods</option>'+areas.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');if(areas.includes(currentArea))areaSelect.value=currentArea;
  const q=document.getElementById('searchInput').value.trim().toLowerCase(), area=areaSelect.value, tier=document.getElementById('tierFilter').value, status=document.getElementById('statusFilter').value;
  const filtered=leads.filter(x=>(!q||[x.name,x.address,x.area,x.zip,x.phone,x.email,x.id].some(v=>(v||'').toLowerCase().includes(q)))&&(!area||x.area===area)&&(!tier||x.tier===tier)&&(!status||x.status===status));
  const pageCount=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));currentPage=Math.min(currentPage,pageCount);
  const visible=filtered.slice((currentPage-1)*PAGE_SIZE,currentPage*PAGE_SIZE);
  document.getElementById('leadRows').innerHTML=visible.length?visible.map(x=>`<tr><td><div class="contact-name">${esc(x.name)}</div><div class="contact-sub">${x.email?`${esc(x.email)} · `:''}${x.phone?`<a href="tel:${esc(x.phone.replace(/[^+\d]/g,''))}" style="color:inherit;text-decoration:none">${esc(x.phone)}</a>`:'No public phone'} · ${esc(x.address||'Address not provided')}</div></td><td><div class="location-name">${esc(x.area)}</div><div class="location-zip">${x.zip?`San Diego · ${esc(x.zip)}`:'San Diego, CA'}</div></td><td><span class="license-pill">${esc(x.tier||'Rental lead')} · ${esc(x.id)}</span></td><td><span class="expiry ${expiring(x.expiry)?'soon':''}">${friendlyDate(x.expiry)}</span></td><td><span class="status-pill status-${esc(x.status)}">${STATUS[x.status]||STATUS.new}</span></td><td><div class="row-actions"><button class="icon-action" title="Open in Maps" data-map="${esc(x.address||x.area)}">↗</button><button class="icon-action" title="Lead details" data-open="${esc(x.id)}">•••</button></div></td></tr>`).join(''):leads.length?'<tr><td colspan="6" class="no-match">No leads match these filters. Try a different search.</td></tr>':'';
  const empty=leads.length===0;document.getElementById('emptyState').classList.toggle('show',empty);document.querySelector('.table-wrap table').style.visibility=empty?'hidden':'visible';
  document.getElementById('resultCount').textContent=empty?'No leads loaded':`Showing ${filtered.length?((currentPage-1)*PAGE_SIZE+1):0}–${Math.min(currentPage*PAGE_SIZE,filtered.length)} of ${filtered.length} matches · ${leads.length} saved`;
  const prev=document.getElementById('leadPrev'),next=document.getElementById('leadNext'),pageLabel=document.getElementById('leadPage');
  if(prev&&next&&pageLabel){prev.disabled=currentPage<=1;next.disabled=currentPage>=pageCount;pageLabel.textContent=`Page ${currentPage} of ${pageCount}`;}
  document.getElementById('navCount').textContent=leads.length>999?'999+':leads.length;
  document.getElementById('statLeads').textContent=leads.length?leads.length.toLocaleString():'—';document.getElementById('statArea').textContent=leads.length?'Active licensed rentals imported':'Import records to get started';
  document.getElementById('statFollowups').textContent=leads.filter(x=>x.followup&&x.followup<=new Date().toISOString().slice(0,10)&&x.status!=='won'&&x.status!=='not_fit').length;
  document.getElementById('statPipeline').textContent=leads.filter(x=>['contacted','replied'].includes(x.status)).length;
  document.getElementById('statWon').textContent=leads.filter(x=>x.status==='won').length;
  document.getElementById('exportBtn').disabled=!leads.length;
  renderSpotlight();
}
function renderSpotlight(){
  if(revealObserver){revealObserver.disconnect();revealObserver=null;}
  const section=document.getElementById('leadSpotlight');
  section.hidden=false;
  const heading=section.querySelector('.spotlight-heading');
  if(!leads.length){
    heading.querySelector('.eyebrow').textContent='YOUR WORKFLOW, IN MOTION';
    heading.querySelector('h2').innerHTML='A sharper way to grow<span>.</span>';
    heading.querySelector('p').textContent='Three small steps take you from local host data to a stronger cleaning pipeline.';
    document.getElementById('spotlightTrack').innerHTML=`<article class="spotlight-card spotlight-feature"><div class="spotlight-card-top"><span class="spotlight-orbit">01</span><span class="spotlight-status">START HERE</span></div><div class="spotlight-location">BRING IN YOUR HOST LIST</div><h3>Import your leads</h3><p>Start with your CSV or the San Diego public license list.</p><div class="spotlight-card-foot"><span>CSV · 1 minute</span><button data-start-import>Import list <span>↗</span></button></div><div class="spotlight-card-glow"></div></article><article class="spotlight-card spotlight-feature"><div class="spotlight-card-top"><span class="spotlight-orbit">02</span><span class="spotlight-status">STAY ORGANIZED</span></div><div class="spotlight-location">MAKE FOLLOW-UPS FEEL EASY</div><h3>Build your pipeline</h3><p>Track conversations, notes, status, and the next follow-up date.</p><div class="spotlight-card-foot"><span>One clear view</span><button data-start-import>Find leads <span>→</span></button></div><div class="spotlight-card-glow"></div></article><article class="spotlight-card spotlight-feature"><div class="spotlight-card-top"><span class="spotlight-orbit">03</span><span class="spotlight-status">RUN THE WORK</span></div><div class="spotlight-location">TURN NEW CLIENTS INTO REPEAT WORK</div><h3>Coordinate every turn</h3><p>Manage jobs, property checklists, team, and turnover photos.</p><div class="spotlight-card-foot"><span>Operations suite</span><button data-start-operations>Open operations <span>↗</span></button></div><div class="spotlight-card-glow"></div></article>`;
    revealElements();return;
  }
  heading.querySelector('.eyebrow').textContent='A GOOD PLACE TO START';
  heading.querySelector('h2').innerHTML='Fresh on your radar<span>.</span>';
  heading.querySelector('p').textContent='Swipe through your contacts and open the ones you want to work.';
  const rank={new:0,contacted:1,replied:2,won:3,not_fit:4},picks=[];for(const lead of leads){const item={lead,score:rank[lead.status]??5};let at=picks.findIndex(x=>item.score<x.score||(item.score===x.score&&String(lead.area).localeCompare(String(x.lead.area))<0));if(at<0)at=picks.length;picks.splice(at,0,item);if(picks.length>8)picks.pop();}const topLeads=picks.map(x=>x.lead);
  document.getElementById('spotlightTrack').innerHTML=topLeads.map((x,i)=>`<article class="spotlight-card" style="--card-order:${i}"><div class="spotlight-card-top"><span class="spotlight-orbit">${esc((x.name||'C').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase())}</span><span class="spotlight-status">${STATUS[x.status]||STATUS.new}</span></div><div class="spotlight-location">${esc(x.area)}${x.zip?` · ${esc(x.zip)}`:''}</div><h3>${esc(x.name)}</h3><p>${esc(x.address||x.listing||'San Diego short-term rental')}</p><div class="spotlight-card-foot"><span>${esc(x.tier||'Host lead')}</span><button data-spotlight-open="${esc(x.id)}">View lead <span>↗</span></button></div><div class="spotlight-card-glow"></div></article>`).join('');
  revealElements();
}
let revealObserver;
function revealElements(){if(!('IntersectionObserver'in window)){document.querySelectorAll('.reveal').forEach(x=>x.classList.add('revealed'));return;}if(!revealObserver)revealObserver=new IntersectionObserver(items=>items.forEach(i=>{if(i.isIntersecting){i.target.classList.add('revealed');revealObserver.unobserve(i.target);}}),{threshold:.12});document.querySelectorAll('.reveal:not(.revealed)').forEach(x=>revealObserver.observe(x));}
function openLead(id){selectedId=id;const x=leads.find(a=>a.id===id);if(!x)return;
  document.getElementById('modalName').textContent=x.name;document.getElementById('modalAddress').textContent=`${x.address||'Address not provided'} · ${x.area}${x.zip?` ${x.zip}`:''}`;
  document.getElementById('modalMeta').innerHTML=[x.tier||'Rental lead',x.id,x.email||x.phone||'No direct contact listed'].map(v=>`<span>${esc(v)}</span>`).join('');
  document.getElementById('messagePreview').textContent=`Hi ${x.name.split(/\s+/)[0]}, I’m with CairBnB, a local San Diego short-term rental cleaning team. We help hosts keep changeovers smooth and guest-ready. If you’re ever looking for a reliable backup or a new cleaning partner near ${x.area}, I’d be happy to share our checklist and availability. Would it be useful if I sent over a few details?\n\nBest,\nCairBnB`;
  document.getElementById('emailLead').disabled=!x.email;document.getElementById('textLead').disabled=!x.phone;document.getElementById('profileLead').disabled=!x.contactLink;
  document.getElementById('leadNotes').value=x.notes||'';document.getElementById('modalStatus').value=x.status||'new';document.getElementById('modalFollowup').value=x.followup||'';document.getElementById('modalBackdrop').classList.add('open');
}
function closeLead(){document.getElementById('modalBackdrop').classList.remove('open');selectedId=null;}
function csvCell(value){let text=String(value??'');if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text))text="'"+text;return `"${text.replace(/"/g,'""')}"`;}
function exportCSV(){const columns=['name','email','phone','contactLink','address','listing','area','zip','tier','id','expiry','status','followup','notes'];const csv=[columns.map(csvCell).join(','),...leads.map(x=>columns.map(k=>csvCell(x[k])).join(','))].join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='cairbnb-host-leads.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function limitedResponseText(response){const length=Number(response.headers.get('content-length')||0);if(length>MAX_CSV_BYTES)throw new Error('Public CSV is larger than the 25 MB import limit.');if(!response.body?.getReader){const text=await response.text();if(text.length>MAX_CSV_BYTES)throw new Error('Public CSV is larger than the 25 MB import limit.');return text;}const reader=response.body.getReader(),decoder=new TextDecoder();let size=0,text='';while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_CSV_BYTES){await reader.cancel();throw new Error('Public CSV is larger than the 25 MB import limit.');}text+=decoder.decode(value,{stream:true});}return text+decoder.decode();}
async function importPublic(){const btn=document.getElementById('importBtn');btn.disabled=true;btn.innerHTML='<span>◌</span> Loading public list';
  try{const res=await fetch(SOURCE_CSV,{cache:'no-store',credentials:'omit',redirect:'follow'});if(!res.ok)throw new Error('Could not download the City data');const rows=parseCSV(await limitedResponseText(res));if(!rows.length)throw new Error('The City file did not contain usable rows');await addRows(rows);}
  catch(err){if(err instanceof TypeError){toast('Browser blocked the direct download. Choose the City CSV file instead.');document.getElementById('csvInput').click();}else toast(err.message||'The public list could not be imported.');}
  finally{btn.disabled=false;btn.innerHTML='<span>＋</span> Import public leads';}
}
function chooseCSV(){document.getElementById('csvInput').click();}
try{leads=await loadLeads();}catch{leadStorageUnavailable=true;toast('Could not open saved leads in this browser.');}
document.getElementById('importBtn').addEventListener('click',importPublic);document.getElementById('emptyImport').addEventListener('click',importPublic);document.getElementById('sidebarImport').addEventListener('click',importPublic);
document.getElementById('csvInput').addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>MAX_CSV_BYTES)throw new Error('CSV is larger than the 25 MB import limit.');const rows=parseCSV(await file.text());if(!rows.length)throw new Error('No records found. Please select the City STRO licenses CSV.');await addRows(rows);}catch(err){toast(err.message);}e.target.value='';});
let searchTimer;document.getElementById('searchInput').addEventListener('input',()=>{currentPage=1;clearTimeout(searchTimer);searchTimer=setTimeout(render,120);});
['areaFilter','tierFilter','statusFilter'].forEach(id=>document.getElementById(id).addEventListener('change',()=>{currentPage=1;render();}));
document.getElementById('leadPrev').addEventListener('click',()=>{if(currentPage>1){currentPage--;render();}});document.getElementById('leadNext').addEventListener('click',()=>{currentPage++;render();});
document.getElementById('leadRows').addEventListener('click',e=>{const open=e.target.closest('[data-open]'),map=e.target.closest('[data-map]');if(open)openLead(open.dataset.open);if(map)window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(map.dataset.map)}`,'_blank','noopener');});
document.getElementById('spotlightTrack').addEventListener('click',e=>{const b=e.target.closest('[data-spotlight-open]'),importAction=e.target.closest('[data-start-import]'),ops=e.target.closest('[data-start-operations]');if(b)openLead(b.dataset.spotlightOpen);if(importAction)importPublic();if(ops)location.href='operations.html';});
document.getElementById('spotlightPrev').addEventListener('click',()=>document.getElementById('spotlightTrack').scrollBy({left:-340,behavior:'smooth'}));document.getElementById('spotlightNext').addEventListener('click',()=>document.getElementById('spotlightTrack').scrollBy({left:340,behavior:'smooth'}));
document.getElementById('modalClose').addEventListener('click',closeLead);document.getElementById('modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeLead();});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLead();});
document.getElementById('saveLead').addEventListener('click',async()=>{const x=leads.find(a=>a.id===selectedId);if(!x)return;const old={notes:x.notes,status:x.status,followup:x.followup};x.notes=document.getElementById('leadNotes').value.trim().slice(0,10000);x.status=Object.hasOwn(STATUS,document.getElementById('modalStatus').value)?document.getElementById('modalStatus').value:'new';x.followup=/^\d{4}-\d{2}-\d{2}$/.test(document.getElementById('modalFollowup').value)?document.getElementById('modalFollowup').value:'';if(!await persist(leads,[x])){Object.assign(x,old);return;}render();closeLead();toast('Lead saved on this device');});
document.getElementById('copyMessage').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(document.getElementById('messagePreview').textContent);toast('Message copied. Personalize it before sending.');}catch{toast('Clipboard unavailable in this browser.');}});
function currentMessage(){return document.getElementById('messagePreview').innerText.trim();}
document.getElementById('emailLead').addEventListener('click',()=>{const x=leads.find(a=>a.id===selectedId);if(!x?.email)return;const subject=`Local turnover cleaning for ${x.area}`;window.location.href=`mailto:${encodeURIComponent(x.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(currentMessage())}`;toast('Email draft opened in your mail app. Review and send it there.');});
document.getElementById('textLead').addEventListener('click',()=>{const x=leads.find(a=>a.id===selectedId);if(!x?.phone)return;const phone=x.phone.replace(/[^+\d]/g,'');window.location.href=`sms:${phone}?&body=${encodeURIComponent(currentMessage())}`;toast('Text draft opened in your messaging app. Review and send it there.');});
document.getElementById('profileLead').addEventListener('click',()=>{const x=leads.find(a=>a.id===selectedId);if(!x?.contactLink)return;try{const url=new URL(x.contactLink.startsWith('http')?x.contactLink:`https://${x.contactLink}`);if(!['https:','http:'].includes(url.protocol))throw new Error();window.open(url.href,'_blank','noopener,noreferrer');}catch{toast('The imported profile link is not a valid web address.');}});
document.getElementById('exportBtn').addEventListener('click',exportCSV);
document.querySelector('.help-button').addEventListener('click',()=>toast('Import the City CSV, filter by area, then review and save your follow-ups.'));
const commands=[{label:'Import public leads',meta:'Upload or refresh your host CSV',run:importPublic},{label:'Export lead list',meta:'Download your contacts and follow-ups',run:exportCSV},{label:'Open cleaning operations',meta:'Schedule, team, properties, and finances',run:()=>location.href='operations.html'}];let commandIndex=0;
function drawCommands(){const q=document.getElementById('commandInput').value.trim().toLowerCase();const list=commands.filter(c=>(c.label+' '+c.meta).toLowerCase().includes(q));commandIndex=Math.min(commandIndex,Math.max(0,list.length-1));document.getElementById('commandResults').innerHTML=list.map((c,i)=>`<button class="command-result ${i===commandIndex?'selected':''}" data-command-index="${commands.indexOf(c)}"><span class="command-result-icon">${i===0?'↥':i===1?'⇩':'▤'}</span><span><b>${c.label}</b><small>${c.meta}</small></span><kbd>↵</kbd></button>`).join('')||'<div class="command-empty">No matching action. Try “import” or “operations”.</div>';}
function openCommands(){document.getElementById('commandBackdrop').classList.add('open');document.getElementById('commandInput').value='';commandIndex=0;drawCommands();setTimeout(()=>document.getElementById('commandInput').focus(),30);}
function closeCommands(){document.getElementById('commandBackdrop').classList.remove('open');}
document.querySelector('[data-command-open]').addEventListener('click',openCommands);document.getElementById('commandInput').addEventListener('input',()=>{commandIndex=0;drawCommands();});document.getElementById('commandResults').addEventListener('click',e=>{const b=e.target.closest('[data-command-index]');if(!b)return;closeCommands();commands[Number(b.dataset.commandIndex)].run();});document.getElementById('commandBackdrop').addEventListener('click',e=>{if(e.target.id==='commandBackdrop')closeCommands();});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openCommands();}if(!document.getElementById('commandBackdrop').classList.contains('open'))return;if(e.key==='Escape'){closeCommands();}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const q=document.getElementById('commandInput').value.trim().toLowerCase(),list=commands.filter(c=>(c.label+' '+c.meta).toLowerCase().includes(q));if(list.length){commandIndex=(commandIndex+(e.key==='ArrowDown'?1:-1)+list.length)%list.length;drawCommands();}}else if(e.key==='Enter'){const b=document.querySelector('.command-result.selected');b?.click();}});
render();revealElements();
